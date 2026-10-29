# Hinok US — Direct Product Feed Pipeline

Shopify 번들 제품(The Spray Set 등)을 포함한 판매 가능 카탈로그를 Meta Commerce Manager와 Google Merchant Center용 CSV로 각각 생성하여 GitHub Pages로 호스팅합니다.

## 왜 필요한가?

Shopify 내장 Bundles 앱으로 만든 번들 제품은 `bundleComponents` 속성 때문에 Shopify 내장 Facebook & Instagram 채널에서 퍼블리싱이 차단됩니다. 이 파이프라인은 Shopify Admin API에서 직접 제품 데이터를 가져와 Meta 피드를 생성합니다.

## 구조

```
src/generate-feed.js          # Shopify GraphQL → Meta / Google CSV 변환 스크립트
src/google-copy.js            # Google 전용 문구 및 구조화 속성 처리
config/google-copy.json        # 상품 옵션 ID별 Google 제목·설명
docs/feed.csv                  # 생성된 피드 파일 (GitHub Pages로 서빙)
docs/google-feed.csv           # Google Merchant Center primary feed
.github/workflows/meta-feed.yml  # 매일 자동 실행 워크플로우
```

## 셋업

### 1. 환경변수 (GitHub Secrets)

| Secret | 설명 |
|--------|------|
| `SHOPIFY_STORE_URL` | Shopify 스토어 도메인 (예: `hinok-us.myshopify.com`) |
| `SHOPIFY_ACCESS_TOKEN` | Admin API 액세스 토큰 (`shpat_...`) |
| `SLACK_WEBHOOK_URL` | (선택) 실패 알림용 Slack 웹훅 URL |

GitHub repo → Settings → Secrets and variables → Actions → **New repository secret**

### 2. GitHub Variables (선택)

| Variable | 기본값 | 설명 |
|----------|--------|------|
| `STORE_DOMAIN` | `https://hinok.us` | 커스텀 도메인 |
| `BRAND` | `Hinok` | 피드 brand 필드 |

### 3. Shopify Admin API 토큰 생성

1. Shopify Admin → Settings → Apps and sales channels → **Develop apps**
2. 새 앱 생성 → Admin API scopes에서 `read_products`, `read_inventory` 선택
3. Install → **Admin API access token** 복사

### 4. GitHub Pages 활성화

1. GitHub repo → Settings → Pages
2. Source: **Deploy from a branch**
3. Branch: `main`, Folder: `/docs`
4. Save

피드 URL:

- Meta: `https://<owner>.github.io/hinok-product-feed/feed.csv`
- Google: `https://<owner>.github.io/hinok-product-feed/google-feed.csv`

### 5. Meta Commerce Manager 연결

1. [Meta Commerce Manager](https://business.facebook.com/commerce/) 접속
2. 카탈로그 → Data sources → **Add items** → **Data feed**
3. 위 GitHub Pages URL 입력
4. Schedule: **Daily** (자동 fetch)

## 로컬 실행

```bash
cp .env.example .env
# .env 파일에 실제 값 입력

npm install
npm run generate
npm run generate:dry  # Shopify 조회 + 두 피드 검증, 파일 미작성
```

`docs/feed.csv` 에 피드 파일이 생성됩니다.

Google 피드는 `docs/google-feed.csv`에 생성됩니다. Shopify Online Store publication에 공개된 활성 상품만 포함하며, Google Shopping용 제목·카테고리·custom label을 별도로 적용합니다.

### Google Merchant Center 연결

1. Merchant Center → Settings → Data sources
2. `docs/google-feed.csv`의 GitHub Pages URL을 US / English / USD의 **단일 Primary source**로 등록
3. 기존 Google & YouTube 앱 데이터 소스는 새 소스의 상품 승인·가격 검증 후 제거
4. 상품 ID는 Shopify variant ID 숫자값을 사용하므로 구형 앱 offer와 충돌하지 않음

Merchant API 관리 명령:

```bash
npm run google:merchant -- auth
npm run google:merchant -- list
npm run google:merchant -- create          # dry-run
npm run google:merchant -- create --apply  # 생성 + 즉시 fetch
npm run google:merchant -- status <data-source-id>
```

OAuth 자격 증명은 gitignore된 로컬 `.env`에만 저장됩니다. 데이터 소스 삭제는 ID 조회와 표시 이름 일치가 모두 확인된 경우에만 `--apply --name`으로 실행됩니다.

Google custom label 정의:

| Label | 정의 | 예시 |
|---|---|---|
| `custom_label_0` | 제품군 | `spray`, `hair_care`, `body_care` |
| `custom_label_1` | 제품 역할 | `starter_set`, `gift_set`, `refill` |
| `custom_label_2` | 가격대 | `aov_50_plus`, `aov_30_49` |
| `custom_label_3` | Shopping 입찰 우선순위 | `high`, `medium`, `low` |
| `custom_label_4` | 재고 상태 | `in_stock`, `continue_selling`, `out_of_stock` |

## 피드 필드 매핑

| Meta 필드 | 소스 |
|-----------|------|
| `id` | Shopify variant ID 숫자값 (Meta 픽셀 `content_id`와 일치) |
| `title` | 제품명 + 배리언트명 |
| `description` | 제품 설명 (plain text) |
| `availability` | 재고 기반 `in stock` / `out of stock` |
| `condition` | `new` (고정) |
| `price` | 정가 (compare_at_price 또는 price) — `"49.00 USD"` |
| `sale_price` | 할인가 (compare_at_price가 있을 때만) |
| `link` | `https://hinok.us/products/{handle}?variant={id}` |
| `image_link` | 배리언트 이미지 또는 메인 이미지 |
| `additional_image_link` | 추가 제품 이미지 |
| `brand` | `Hinok` |
| `product_type` | Shopify product type |

## 자동화

GitHub Actions가 매일 UTC 06:00 (KST 15:00)에 실행됩니다.

- 실패 시 Slack 알림 전송 (`SLACK_WEBHOOK_URL` 설정 시)
- Actions 탭에서 **Run workflow** 버튼으로 수동 실행 가능
- 피드 파일 변경이 없으면 빈 커밋은 생성되지 않음

## Google 제목과 설명 수정하기

현재 Google용 피드 주소는 <https://techefg.github.io/hinok-product-feed/google-feed.csv>입니다.
Shopify 상품·옵션·가격·재고 → 생성 스크립트 → `docs/google-feed.csv` → GitHub Pages → Merchant Center 순서로 전달됩니다. CSV 한 행은 Shopify 상품 옵션 하나이며, `id`는 해당 옵션의 숫자 ID입니다.

Google에만 사용할 문구는 `config/google-copy.json`에서 수정합니다. Shopify 상품 페이지나 Meta 설명에는 적용되지 않습니다. 예를 들어 스프레이·핸드워시 세트의 900 mL 옵션은 아래 구조입니다.

```json
"52662593388676": {
  "handle": "the-spray-hand-wash-set",
  "title": "hinok Jeju Hinoki Cypress Spray & Hand Wash Set, Spray 900 mL + Hand Wash 450 mL",
  "description": "..."
}
```

- `title`을 생략하면 기존 Google 제목 생성 규칙을 유지합니다.
- `description`을 생략하면 Shopify의 일반 상품 설명을 사용합니다.
- Shopify의 SEO 제목·SEO 설명·태그는 이 피드의 제목·설명으로 사용하지 않습니다.
- 구성·용량·성분은 연결된 상품 페이지와 일치해야 합니다. 구성이나 옵션을 바꿀 때 이 파일도 확인합니다.
- `docs/google-feed.csv`를 직접 편집하지 않습니다. 다음 자동 실행에서 다시 생성됩니다.
- 현재 overrides는 생성형 AI로 작성된 문구이므로 Google 규격에 따라 `structured_title` / `structured_description`에 출처와 본문을 함께 전달합니다. 대응하는 일반 `title` / `description` 칸은 비웁니다. 두 속성을 동시에 보내면 Google은 일반 속성을 우선합니다. 이 출처 값은 고객용 상품 문구에 덧붙이는 문장이 아닙니다.

검증은 `npm test`와 `npm run generate:dry`로 실행합니다. 배포 시 변경 코드를 `main`에 반영하고 Actions의 **Generate Meta and Google Product Feeds → Run workflow**를 실행합니다. GitHub Pages의 CSV가 바뀐 뒤 Merchant Center의 기존 데이터 소스 **hinok direct feed - US**에서 **Fetch now**를 실행하면 수집을 앞당길 수 있습니다. 새로운 primary source를 만들거나 기존 상품 ID를 바꾸지 않습니다.

자동 생성은 매일 06:00 UTC(한국 15:00), Merchant Center 수집은 매일 08:00 America/Los_Angeles로 설정되어 있습니다. 스케줄 변경 시 실제 서비스 설정을 함께 확인합니다. CSV 게시와 Google의 처리·승인, 광고 노출 반영은 별개이므로 마지막에는 Merchant Center에서 최종 제목·설명과 상품 상태를 확인합니다.

되돌릴 때는 변경 커밋을 되돌린 뒤 같은 생성·게시·수집 절차를 실행합니다. Google 전용 문구 한 항목만 원복하려면 설정 파일에서 해당 `title` 또는 `description`을 제거합니다.

규격: [Google 제목 속성](https://support.google.com/merchants/answer/6324415?hl=en), [Google 설명 속성](https://support.google.com/merchants/answer/6324468?hl=en).
