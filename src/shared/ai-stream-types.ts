/**
 * `ai:done` 완료 메타 — main → preload → renderer 가 **같은 타입**을 본다.
 *
 * QA33(H5): 종전에는 이 모양이 세 곳에 각자 있었다 — main 의 `StreamDoneMeta`(두 필드), preload
 * 브리지의 인라인 `{ truncated?: true }`(한 필드), 그리고 그것을 읽는 `AiClient`(한 필드).
 * 그 결과 QA32 가 추가한 `inputTruncated`(입력이 컨텍스트 상한을 넘어 **앞부분이 잘린 채**
 * 평가됐다는 신호)는 main 이 실어 보내기만 하고 **렌더러에 소비자가 없었다**: preload 타입에
 * 필드가 없으니 타입이 그 존재를 표현조차 못 했고, `AiClient` 에는 대응 게터가 없었다.
 *
 * 그 침묵의 결과는 이 라운드가 없애려는 바로 그 실패다 — 컨텍스트를 넘긴 프롬프트는 llama.cpp
 * 가 **앞에서부터** 버리는데 프롬프트의 앞은 system 섹션(인용 규칙)이라, 사용자에게는 "인용이
 * 안 붙는 요약" 으로만 보이고 `done_reason` 은 `stop` 이라 절단 감지에도 걸리지 않는다.
 *
 * 메타에 필드를 더할 때 세 자리가 함께 움직이도록 타입을 여기 하나로 둔다.
 */
export interface StreamDoneMeta {
  /** 모델이 출력 상한(max_tokens/컨텍스트)에 걸려 **문장 중간에서** 끝났는가. */
  truncated?: true;
  /**
   * **입력**이 컨텍스트 상한을 넘어 앞부분이 잘린 채 평가됐는가 (QA32 A-5).
   * `truncated`(출력)와 원인·회복 수단이 다르다 — 이쪽은 청크 크기를 낮춰야 한다.
   */
  inputTruncated?: true;
}
