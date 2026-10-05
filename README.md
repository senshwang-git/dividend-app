# 배당 통장

국내·미국 배당주를 일반·ISA·연금 계좌에 나눠 담았을 때 세후 배당금과 잔액이 어떻게 변하는지 보는 휴대폰용 웹앱입니다.

- 앱 주소: https://senshwang-git.github.io/dividend-app/
- 안드로이드 크롬에서 열고 메뉴 → **앱 설치**(또는 홈 화면에 추가)
- 시세: Yahoo Finance, 평일 하루 두 번 자동 갱신 (`.github/workflows/update.yml`)
- 저장: 설정·결과는 그 기기 브라우저에 저장됩니다. 저장함 탭의 **백업 파일 저장**으로 보관하세요.

이 저장소가 배당 통장의 원본입니다. `site/`를 고쳐 main에 푸시하면 바로 다시 배포됩니다(빌드 단계 없음).
claude.ai에 고정한 배당 통장 아티팩트도 같은 `site/` 파일을 올린 것이며, 그 화면의 새로고침 버튼은 이 저장소의 `update.yml`을 실행합니다.

로컬 확인: `cd site && python -m http.server` → http://localhost:8000
테스트: `node --test dividend/*.test.mjs`

| 폴더 | 내용 |
|---|---|
| `site/` | 배포되는 앱 (화면, 계산 엔진, 시세 data.json, manifest, 서비스 워커, 아이콘) |
| `dividend/` | 종목 목록(`universe.json`, 종목 추가는 여기서), 시세 수집 스크립트, 엔진 테스트 |
