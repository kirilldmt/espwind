# Фиксированный спот и станции v4

Единственный прогнозный спот — **Крон**, [Windy.app 585111](https://windy.app/forecast2/spot/585111), координаты **60.0111353, 29.6915455**. Ключ почасового контракта сохранён: `kro`. Модель GFS27.

Факт запрашивается у Windy.app без прогнозного продолжения (`predict=0`):

- [КАЙТПИТЕР · 1chipru_840d8eaa9b63](https://api.windyapp.co/v10/meteostations/getData/1chipru_840d8eaa9b63?predict=0&canWindNull=1&info=1) — экран 4.
- [ПУЛКОВО · ULLI](https://api.windyapp.co/v10/meteostations/getData/ULLI?predict=0&canWindNull=1&info=1) — экран 5.

Измерения относятся к месту установки каждого датчика и не корректируют GFS27. Выбор спотов/станций отсутствует; старые сохранённые ID не восстанавливаются. Все подписи времени — Москва.
