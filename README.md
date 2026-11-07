# Academic Feed

학술 RSS를 읽기 위한 개인용 영문·한국어 피드.

## 구성
- 자료: Nature, Nature Human Behaviour, arXiv AI
- Cloudflare Workers: 매일 01:00 KST, 출처별 신규 최대 20건 수집. 전체 기사는 GitHub로 넘기기 위해 3일만 보관하며, 중복 방지 식별자만 30일 유지
- GitHub Actions: 매일 02:00 KST, **공개된 Cloudflare JSON API**에서 이미 수집한 영문 기사를 가져와 `docs/data/en.json`에 저장하고 GitHub Pages 배포
- 보관 기간: 영문·한국어 기사 모두 최근 30일
- ChatGPT 예약 확인: 매일 04:00 KST, 신규 미번역 기사를 확인하고 사용자에게 번역·게시 승인 요청
- **사용자 승인 후에만** ChatGPT 일반 대화에서 신규 기사를 한국어로 번역해 `docs/data/ko.json`에 게시. 별도 OpenAI API 사용 없음

## 읽기
- 영어: https://amara-an.github.io/news-feed/en/
- 한국어: https://amara-an.github.io/news-feed/ko/
- 수집 로그: https://github.com/amara-an/news-feed/actions

## 수동 시험
1. GitHub → Actions → Collect academic feeds → Run workflow
2. 실행 로그의 Cloudflare HTTP 호출과 import 결과 확인
3. `docs/data/en.json`의 기사와 GitHub Pages 배포 결과 확인

GitHub에서 학술 RSS를 직접 호출하지 않는다. Cloudflare의 기존 검증된 수집기를 계속 사용한다. 실패 시 기존 GitHub JSON을 덮어쓰지 않도록 Cloudflare 데이터가 비어 있거나 형식이 틀리면 수집 워크플로를 실패 처리한다.

## Cloudflare Worker v3 배포
- 최신 단일 파일: [cloudflare/worker.js](cloudflare/worker.js)
- Cloudflare 대시보드의 기존 Worker에 위 파일 **전체 코드를 교체**하여 배포. 기존 D1 `DB` 바인딩과 cron `0 16 * * *` 유지.
- 별도 D1 수동 마이그레이션은 필요 없다. 최초 cron 수집 때 기존 본문 식별자를 `af_v3_seen`에 옮긴 다음 본문은 3일치만 유지한다.
- **기존 Worker를 지우거나 DB를 초기화하지 말 것.** Cloudflare 직접 배포는 GitHub 연결 권한에 포함되지 않음.
