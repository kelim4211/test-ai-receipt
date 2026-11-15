export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '잘못된 접근입니다.' });
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: '이미지 데이터가 없습니다.' });

    const imageBase64 = image.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Vercel 환경 변수에 GEMINI_API_KEY가 설정되지 않았습니다.' });

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
    const systemPrompt = `전문 분석기입니다. JSON을 절대 출력하지 마십시오. 오직 아래의 줄 단위 텍스트 형식 규칙에 맞춰서만 출력하십시오. 긴 영수증의 모든 품목을 누락 없이 빠짐없이 전부 추출하십시오.

[출력 양식]
SHOP: 상호명[OCR] | 상호명[AI복원] | 업종및가게성격 | 일자 | 주소 | 상호명발췌근거 | 검색용대표브랜드명
ITEM: 원본제품명 | 정밀복원제품명 | 단가곱하기수량의합 | 할인액 | 품목종속할인명(없으면 '없음') | 최종금액
ETC: 항목명 | 부호를포함한금액
TOTAL: 인쇄된_최종결제총액

[상호명 및 대표 브랜드 규칙]
1. 상호명[OCR]: 식별 가능한 경우만 표기, 없으면 반드시 '정보없음'.
2. 상호명[AI복원]: OCR이 '정보없음'일 때 고유 제품명 등을 통해 확실한 경우만 상호명 기재, 모호하면 '정보없음'.
3. 상호명발췌근거: "제품 검색을 통해 확인된 신뢰할 수 있는 고유 제품명 [제품명]을(를) 통해 정확하다고 판단되는 [상호명] 발췌"
4. 검색용대표브랜드명: 법인명((주) 등)과 지점명 완전히 제거한 '핵심 브랜드명' 1단어.

[할인 분류 원칙]
1. 상품 종속 할인 (ITEM 라인에 반영): 특정 개별 품목 바로 아래에 인쇄되어 귀속되는 경우.
2. 거래/결제 종속 할인 (ETC 라인): 통신사, 제휴, 쿠폰 등 전체 구매조건 차감.

[제외 규칙]
- 세금 분리 라인 및 단순 수납 라인은 ITEM/ETC에서 완전 제외.`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { max_output_tokens: 8192 },
        contents: [{ parts: [{ text: "모든 품목을 누락 없이 정밀 분석하여 출력하십시오." }, { inline_data: { mime_type: "image/jpeg", data: imageBase64 } }] }]
      })
    });

    const responseText = await response.text();
    if (!response.ok) return res.status(500).json({ error: `AI 서버 통신 실패 (${response.status}): ${responseText}` });

    let parsedApiResponse;
    try { parsedApiResponse = JSON.parse(responseText); } catch (e) { return res.status(500).json({ error: `AI 응답 파싱 실패` }); }

    const rawText = parsedApiResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) return res.status(500).json({ error: 'AI 분석 결과가 비어 있습니다.' });

    const resultData = {
      shopOcr: '정보없음', shopName: '정보없음', shopConfidence: 'none', shopReason: '',
      shopIndustry: '', date: '미확인', address: '정보없음', searchBrand: '',
      overallElements: [], products: [], receiptTotal: 0, verificationStatus: 'NORMAL', verificationMessage: ''
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
        let rawShopOcr = parts[0] || '정보없음', isOcrValid = !(rawShopOcr.includes('미확인') || rawShopOcr.includes('정보없음') || rawShopOcr.length < 2);
        resultData.shopOcr = isOcrValid ? rawShopOcr : '정보없음';
        if (!isOcrValid && parts[1] && !parts[1].includes('정보없음') && parts[1].length >= 2) {
          resultData.shopName = parts[1]; resultData.shopConfidence = 'estimated'; resultData.shopReason = parts[5] || '';
        } else {
          resultData.shopName = isOcrValid ? rawShopOcr : '정보없음'; resultData.shopConfidence = isOcrValid ? 'official' : 'none';
        }
        resultData.shopIndustry = parts[2] || ''; resultData.date = parts[3] || '미확인'; resultData.address = parts[4] || '정보없음';
        resultData.searchBrand = (parts[6] && parts[6] !== '없음' && !parts[6].includes('정보없음')) ? parts[6] : '';
      } else if (trimmed.startsWith('ITEM:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        if (parts[0] && !isExcluded(parts[0])) {
          resultData.products.push({
            productOcr: parts[0],
            productAi: parts[1] || parts[0],
            totalPrice: cleanNum(parts[2], '0'),
            discount: cleanNum(parts[3], '0'),
            discountName: (parts.length >= 6 && parts[4] !== '없음') ? parts[4] : '',
            finalPrice: parts.length >= 6 ? cleanNum(parts[5], cleanNum(parts[2], '0')) : cleanNum(parts[4], cleanNum(parts[2], '0'))
          });
        }
      } else if (trimmed.startsWith('TOTAL:')) {
        resultData.receiptTotal = Number(cleanNum(trimmed.substring(6), '0'));
      } else if (trimmed.startsWith('ETC:')) {
        const parts = trimmed.substring(4).split('|').map(cleanStr);
        let name = parts[0].replace(/^[*\s]+/, '') || '전체 할인/추가';
        if (!isExcluded(name)) {
          let amt = Number(cleanNum(parts[1] || '0', '0'));
          if (amt > 0) resultData.overallElements.push({ name, amount: (parts[1].includes('-') || /할인|DC|차감|쿠폰|마이너스/i.test(name)) ? `-${amt}` : String(amt) });
        }
      }
    }

    const sumProductsFinal = resultData.products.reduce((acc, p) => acc + Number(p.finalPrice), 0);
    const sumOverallEtc = resultData.overallElements.reduce((acc, el) => acc + Number(el.amount), 0);
    const calculatedTotal = sumProductsFinal + sumOverallEtc;

    if (resultData.receiptTotal > 0) {
      const discrepancy = resultData.receiptTotal - calculatedTotal;
      if (discrepancy !== 0) {
        resultData.verificationStatus = 'DISCREPANCY_AUTO_CORRECTED';
        resultData.overallElements.push({ name: discrepancy < 0 ? "누락 할인 보정" : "누락 추가 요금 보정", amount: String(discrepancy) });
      }
    }

    return res.status(200).json(resultData);
  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 내부 오류가 발생했습니다.' });
  }
}
