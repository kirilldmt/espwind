# Проверка прототипа

Актуальные команды и ограничения находятся в
[общем отчёте](../../docs/VERIFICATION.md) и [README прототипа](../README.md).

```sh
npm --prefix wind64-prototype test
node firmware/tests/parity.mjs
npm --prefix wind64-prototype run test:browser
```

Последняя команда требует установленного Google Chrome. Браузерные тесты
используют синтетические ответы и сохраняют локальные снимки и видео в
`wind64-prototype/artifacts/`. Этот каталог исключён из публичного Git.
Публичная иллюстрация пяти экранов — [здесь](../../docs/images/screens.png).
