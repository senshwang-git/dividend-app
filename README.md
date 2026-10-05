# 배당 통장

국내·미국 배당주를 일반·ISA·연금 계좌에 나눠 담았을 때 세후 배당금과 잔액이 어떻게 변하는지 보는 휴대폰용 웹앱입니다.

- 앱 주소: https://senshwang-git.github.io/dividend-app/
- 안드로이드 크롬에서 열고 메뉴 → **앱 설치**(또는 홈 화면에 추가)
- 시세: Yahoo Finance, 평일 하루 두 번 자동 갱신 (`.github/workflows/update.yml`)
- 저장: 설정·결과는 그 기기 브라우저에 저장됩니다. 저장함 탭의 **백업 파일 저장**으로 보관하세요.

이 저장소는 `senshwang-git/briefing`의 `docs/dividend`에서 `dividend/build_app.py`로 만든 결과물입니다.
화면을 고칠 때는 원본을 고친 뒤 다시 빌드합니다.

| 폴더 | 내용 |
|---|---|
| `site/` | 배포되는 앱 (화면, 계산 엔진, 시세 data.json, manifest, 서비스 워커, 아이콘) |
| `dividend/` | 종목 목록, 시세 수집 스크립트, 엔진 테스트 |
