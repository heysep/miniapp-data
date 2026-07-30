# miniapp-data

토스 미니앱들이 런타임에 읽는 공개 데이터 저장소입니다.

- `chungyak/cutlines.json` — 청약 가점 계산기: 당첨 가점 커트라인 (수동/스크립트 갱신, asOf로 신선도 비교)

앱은 raw URL을 fetch하고 실패 시 번들 시드로 폴백합니다.
