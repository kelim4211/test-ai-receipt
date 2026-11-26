export const maxDuration = 30;

const TARGET_MODEL = 'gemini-3.6-flash';
const SINGLE_ITEM_TIMEOUT_MS = 12000;

function buildOptimizedQuery(rawOcr, brandCtx) {
  const cleanKw = (rawOcr || '')
    .replace(/^[*\s]+/, '')
    .replace(/^\((?:G|기획|행사|증정|냉동|냉장|특가)\)\s*/gi, '')
    .replace(/\([^)]*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (brandCtx && brandCtx !== '없음' && cleanKw && !cleanKw.includes(brandCtx)) {
    return `${brandCtx} ${cleanKw}`.trim();
  }
  return cleanKw;
}

async function searchSingleProduct(apiUrl, item, brandCtx) {
  const ocr = (item?.productOcr || '').trim();
  if (!ocr) return ocr;

  const queryKw = buildOptimizedQuery(ocr, brandCtx);
  const priceText = item?.totalPrice ? `${item.totalPrice}원` : '미상';

  const refinePrompt = `당신은 한국 유통·쇼핑몰 정식 제품명 매칭 전문가입니다.
제공된 '조합검색어'로 Google 검색 도구를 실행하여 네이버 가격비교, SSG닷컴, 이마트몰 등 국내 쇼핑몰에 실제로 존재하는 정식 제품명을 찾고 가장 일치도가 높은 제품명 1개만 선택하십시오.

[매칭 및 복원 원칙]
1. 검색엔진이 임의로 보정해 주는 단순 대표 명사로 무조건 축약하거나 멈추지 말고, 원본 단어·브랜드·가격 맥락과 일치하는 가장 구체적이고 온전한 실존 정식 제품명(예: '비엔' -> '그릴비엔나', '고추장' -> '고추장버터', '빠' -> '빠에야')을 우선 선택하십시오.
2. 글자 오독이나 중간 축약이 있더라도 원본과 가격을 대조해 실제 판매 상품명으로 교정하십시오.
3. 품번이 식별되면 제품 식별 단서로 활용하되, [특가], 무료배송, 1+1, 오늘출발 등 광고 문구는 제거하고 순수 정식 제품명만 출력하십시오.
4. 검색 결과에서 더 명확한 실존 제품명을 찾지 못하면 원본 제품명(${ocr})을 그대로 출력하십시오.
5. 설명, 번호, 따옴표, 줄바꿈 없이 오직 최종 확정된 제품명 한 줄만 출력하십시오.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SINGLE_ITEM_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        system_instruction: { parts: [{ text: refinePrompt }] },
        tools: [{ google_search: {} }],
        generationConfig: {
          max_output_tokens: 256,
          thinkingConfig: { thinkingBudget: 0 }
        },
        contents: [{
          parts: [{
            text: `원본제품명="${ocr}" | 조합검색어="${queryKw}" | 가격=${priceText}`
          }]
        }]
      })
    });

    if (!response.ok) return ocr;
    const data = await response.json();
    const rawOut = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = rawOut
      .split('\n')[0]
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^(정식\s*제품명|제품명|결과)\s*[:：]\s*/i, '')
      .trim();

    if (!cleaned || cleaned.length < 2 || cleaned.length > 80) return ocr;
    return cleaned;
  } catch (e) {
    return ocr;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '잘못된 접근입니다.' });
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Vercel 환경 변수에 GEMINI_API_KEY가 설정되지 않았습니다.' });

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${TARGET_MODEL}:generateContent?key=${apiKey}`;
    const { mode = 'ocr', image, item, brand } = req.body || {};

    if (mode === 'refine') {
      if (!item || !item.productOcr) return res.status(400).json({ error: '검색할 품목 데이터가 없습니다.' });
      const resolvedName = await searchSingleProduct(apiUrl, item, (brand || '').trim());
      return res.status(200).json({ productAi: resolvedName });
    }

    if (!image) return res.status(400).json({ error: '이미지 데이터가 없습니다.' });
    const imageBase64 = image.replace(/^data:image\/(png|jpeg|jpg|webp);base64,/, '');

    const step1Prompt = `전문 영수증 판독기입니다. JSON이나 마크다운 코드블록을 절대 출력하지 마십시오. 오직 아래 규칙에 맞춰 출력하십시오.

[데이터 수집 원칙 (화이트리스트)]
- 영수증에서 오직 가계지출 분석에 필요한 '날짜, 상호명, 주소, 품목명, 단가, 수량, 할인, 결제총액' 데이터만 추출하십시오.
- 사업자등록번호, 대표자 성명, 매장 전화번호, 사업장 직통 연락처 등 민감·결합 정보는 절대 추출하거나 출력하지 말고 완벽히 배제하십시오.

[가장 중요한 규칙 1: 전체 출력 보장]
- 긴 영수증이라도 중간에 임의로 생략하거나 멈추지 말고, 영수증에 인쇄된 모든 품목과 마지막 TOTAL 라인까지 누락 없이 100% 전부 출력하십시오.

[가장 중요한 규칙 2: 원문 충실 판독]
- 영수증에 인쇄된 원본제품명(품번·규격·잘린 글자 포함)을 임의로 바꾸거나 추측하지 말고 있는 그대로 정확히 판독하십시오.

[출력 양식]
SHOP: 상호명[OCR] | 상호명[AI복원] | 일자(YYYY-MM-DD, 시간 제외) | 주소
ITEM: 원본제품명 | 단가곱하기수량의합 | 할인액 | 품목종속할인명(없으면 '없음') | 최종금액
ETC: 항목명 | 부호를포함한금액
TOTAL: 인쇄된_최종결제총액

[상호명 규칙]
1. 상호명[OCR]: 식별 가능한 경우만 표기, 없으면 '정보없음'.
2. 상호명[AI복원]: OCR이 '정보없음'일 때 고유 제품명 등을 통해 확실한 경우만 상호명 기재, 모호하면 '정보없음'.

[할인 분류 원칙]
1. 상품 종속 할인 (ITEM 라인 반영): 특정 개별 품목 바로 아래에 인쇄되어 귀속되는 경우.
2. 거래/결제 종속 할인 (ETC 라인): 통신사, 제휴, 쿠폰 등 전체 구매조건 차감.`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: step1Prompt }] },
        generationConfig: {
          max_output_tokens: 65536,
          thinkingConfig: { thinkingBudget: 0 }
        },
        contents: [{
          parts: [
            { text: "영수증에 인쇄된 모든 품목과 금액을 누락 없이 원문 그대로 판독하여 출력하십시오." },
            { inline_data: { mime_type: "image/jpeg", data: imageBase64 } }
          ]
        }]
      })
    });

    const responseText = await response.text();
    if (!response.ok) return res.status(500).json({ error: `AI 서버 통신 실패 (${response.status}): ${responseText}` });

    let parsedApiResponse;
    try { parsedApiResponse = JSON.parse(responseText); } catch (e) { return res.status(500).json({ error: 'AI 응답 파싱 실패' }); }

    const rawText = parsedApiResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) return res.status(500).json({ error: 'AI 분석 결과가 비어 있습니다.' });

    const resultData = {
      activeModel: TARGET_MODEL,
      shopOcr: '정보없음',
      shopName: '정보없음',
      shopConfidence: 'none',
      date: '미확인',
      address: '정보없음',
      overallElements: [],
      products: [],
      receiptTotal: 0
    };

    const cleanStr = (str) => (str ? str.replace(/^["']|["']$/g, '').trim() : '');
    const cleanNum = (str, fallback = '0') => (str ? (str.replace(/[^0-9]/g, '') || fallback) : fallback);
    const excludedRegex = /과세|부가세|세액|면세|총매출|받은돈|받을금액|거스름|결제금액|합계금액|카드결제|할인합계|총할인|할인총액|할인액합계/i;
    const isExcluded = (name) => excludedRegex.test(name.replace(/\s+/g, ''));

    for (const line of rawText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('SHOP:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        const rawShopOcr = parts[0] || '정보없음';
        const isOcrValid = !(rawShopOcr.includes('미확인') || rawShopOcr.includes('정보없음') || rawShopOcr.length < 2);
        resultData.shopOcr = isOcrValid ? rawShopOcr : '정보없음';
        if (!isOcrValid && parts[1] && !parts[1].includes('정보없음') && parts[1].length >= 2) {
          resultData.shopName = parts[1];
          resultData.shopConfidence = 'estimated';
        } else {
          resultData.shopName = isOcrValid ? rawShopOcr : '정보없음';
          resultData.shopConfidence = isOcrValid ? 'official' : 'none';
        }
        resultData.date = parts[2] || '미확인';
        resultData.address = parts[3] || '정보없음';
      } else if (trimmed.startsWith('ITEM:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        if (parts[0] && !isExcluded(parts[0])) {
          const totalPrice = cleanNum(parts[1], '0');
          const discount = cleanNum(parts[2], '0');
          const finalPrice = cleanNum(parts[4], totalPrice);
          resultData.products.push({
            productOcr: parts[0],
            productAi: parts[0],
            totalPrice,
            discount,
            finalPrice
          });
        }
      } else if (trimmed.startsWith('TOTAL:')) {
        resultData.receiptTotal = Number(cleanNum(trimmed.substring(6), '0'));
      } else if (trimmed.startsWith('ETC:')) {
        const parts = trimmed.substring(4).split('|').map(cleanStr);
        const name = parts[0].replace(/^[*\s]+/, '') || '전체 할인/추가';
        if (!isExcluded(name)) {
          const amt = Number(cleanNum(parts[1] || '0', '0'));
          if (amt > 0) {
            const isMinus = parts[1]?.includes('-') || /할인|DC|차감|쿠폰|마이너스/i.test(name);
            resultData.overallElements.push({ name, amount: isMinus ? `-${amt}` : String(amt) });
          }
        }
      }
    }

    const sumProductsFinal = resultData.products.reduce((acc, p) => acc + Number(p.finalPrice), 0);
    const sumOverallEtc = resultData.overallElements.reduce((acc, el) => acc + Number(el.amount), 0);
    const calculatedTotal = sumProductsFinal + sumOverallEtc;

    if (resultData.receiptTotal > 0) {
      const discrepancy = resultData.receiptTotal - calculatedTotal;
      if (discrepancy !== 0) {
        resultData.overallElements.push({ name: "오류 보정액", amount: String(discrepancy) });
      }
    }

    return res.status(200).json(resultData);
  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 내부 오류가 발생했습니다.' });
  }
}
