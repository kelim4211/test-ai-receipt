const maxDuration = 30;
// 영수증의 흐릿한 글자 판독과 고도의 추론(정밀 품명 매칭)을 위해 가장 뛰어난 Pro 모델 사용
const TARGET_MODEL = 'gemini-3.6-pro';

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '잘못된 접근입니다.' });
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: '이미지 데이터가 없습니다.' });

    const imageBase64 = image.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Vercel 환경 변수에 GEMINI_API_KEY가 설정되지 않았습니다.' });

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${TARGET_MODEL}:generateContent?key=${apiKey}`;

    const systemPrompt = `전문 분석기입니다. JSON을 절대 출력하지 마십시오. 오직 아래의 허용된 항목 규칙에 맞춰서만 출력하십시오.

[데이터 수집 원칙 (화이트리스트)]
- 영수증에서 오직 가계지출 분석에 필요한 '날짜, 상호명, 주소, 품목명, 단가, 수량, 할인, 결제총액' 데이터만 추출하십시오.
- 사업자등록번호, 대표자 성명, 매장 전화번호 등 민감·결합 정보는 절대 추출하거나 출력하지 말고 완벽히 배제할 것.

[가장 중요한 규칙 1: 전체 출력 보장]
- 긴 영수증이라도 중간에 임의로 생략하거나 멈추지 말고, 영수증에 인쇄된 모든 품목과 마지막 TOTAL 라인까지 누락 없이 100% 전부 출력하십시오. 토큰 제한으로 중간에 끊기는 일이 절대 없도록 하십시오.

[가장 중요한 규칙 2: 품명 및 상호명 정밀 복원 및 잘림 판별 원칙]
1. 잘림 및 오독 판별 기준:
   - 영수증 텍스트가 의미가 완결되지 않은 채 음절이나 글자 중간에서 끊겼거나, 인쇄 제한으로 뒷부분이 누락된 경우 '잘린 품목'으로 판별하십시오.
   - 글자가 흐릿하거나 인쇄 불량으로 오독하기 쉬운 경우(예: '피코크 오징어먹물 빠'를 '피코크 오징어먹물 바'로 읽은 경우), 오독된 단어('바')에 갇혀 지레짐작으로 엉뚱한 제품('바게트')을 복원하지 마십시오. 반드시 실제 브랜드명, 앞 키워드('피코크 오징어먹물'), 가격('6,980원')의 맥락을 결합해 분석하십시오.

2. 실제 판매되는 명확한 제품명 최우선 매칭 (핵심 원칙):
   - '네이버 쇼핑 가격비교', 'SSG닷컴', '이마트몰' 등 국내 주요 쇼핑 플랫폼에 정확히 존재하는 실제 상품명(예: '피코크 오징어먹물 빠에야 500g')이 검색되거나 존재할 경우, 이 완벽한 실제 명칭을 최우선 채택하여 복원하십시오. 
   - 가상의 수식어나 오인하기 쉬운 다른 상품군(예: 바게트 등)보다, 실존하는 브랜드 매칭 상품을 절대적인 우선순위로 매칭해야 합니다.

[출력 양식]
SHOP: 상호명[OCR] | 상호명[AI복원] | 일자(날짜만 YYYY-MM-DD 형태로 추출, 시간 제외) | 주소 | 상호명발췌근거 | 검색용대표브랜드명
ITEM: 원본제품명 | 정밀복원제품명(실제 온라인 쇼핑몰 검색 기반 최우선 정식 품명) | 단가곱하기수량의합 | 할인액 | 품목종속할인명(없으면 '없음') | 최종금액
ETC: 항목명 | 부호를포함한금액
TOTAL: 인쇄된_최종결제총액

[상호명 및 대표 브랜드 규칙]
1. 상호명[OCR]: 식별 가능한 경우만 표기, 없으면 반드시 '정보없음'.
2. 상호명[AI복원]: OCR이 '정보없음'일 때 고유 제품명 등을 통해 확실한 경우만 상호명 기재, 모호하면 '정보없음'.
3. 상호명발췌근거: "제품 검색을 통해 확인된 신뢰할 수 있는 고유 제품명 [제품명]을(를) 통해 정확하다고 판단되는 [상호명] 발췌"
4. 검색용대표브랜드명: 법인명((주) 등)과 지점명 완전히 제거한 '핵심 브랜드명' 1단어.

[할인 분류 원칙]
1. 상품 종속 할인 (ITEM 라인에 반영): 특정 개별 품목 바로 아래에 인쇄되어 귀속되는 경우.
2. 거래/결제 종속 할인 (ETC 라인): 통신사, 제휴, 쿠폰 등 전체 구매조건 차감.`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { 
          max_output_tokens: 65536,
          // 긴 영수증의 미세 글자를 뭉개짐 없이 정밀하게 판독하기 위해 화질을 상향하여 API 호출
          mediaResolution: "MEDIA_RESOLUTION_HIGH" 
        },
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
      activeModel: TARGET_MODEL,
      shopOcr: '정보없음', shopName: '정보없음', shopConfidence: 'none', shopReason: '',
      date: '미확인', address: '정보없음', searchBrand: '',
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
        resultData.shopOcr = isOcrValid ? rawShopOcr : '정보
