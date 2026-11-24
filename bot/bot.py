"""
Crystal Mines — Telegram-бот, который открывает мини-приложение.
Работает без сторонних библиотек (только стандартный Python 3.8+).

Запуск:  python bot.py
Настройки берутся из файла .env рядом со скриптом (BOT_TOKEN, WEBAPP_URL).
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def load_env(path):
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


load_env(os.path.join(HERE, ".env"))
TOKEN = os.environ.get("BOT_TOKEN", "")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "")
API = f"https://api.telegram.org/bot{TOKEN}/"

if not TOKEN:
    sys.exit("Нет BOT_TOKEN в .env")
if not WEBAPP_URL.startswith("https://") or "ВАШ-НИК" in WEBAPP_URL:
    sys.exit("Укажи в .env настоящий WEBAPP_URL (https://...), где лежит webapp/index.html")


def call(method, **params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(API + method, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=40) as r:
        res = json.loads(r.read().decode())
    if not res.get("ok"):
        raise RuntimeError(res)
    return res["result"]


def play_keyboard():
    return {"inline_keyboard": [[{"text": "💎 Играть", "web_app": {"url": WEBAPP_URL}}]]}


def on_message(msg):
    chat_id = msg["chat"]["id"]
    text = msg.get("text", "")
    name = msg.get("from", {}).get("first_name", "шахтёр")
    if text.startswith("/start") or text.startswith("/play"):
        call("sendMessage", chat_id=chat_id, parse_mode="HTML", reply_markup=play_keyboard(), text=(
            f"Привет, <b>{name}</b>! 💎\n\n"
            "<b>Crystal Mines</b> — открывай плитки, собирай кристаллы и не попадись в ловушку.\n\n"
            "🎯 Ежедневные миссии и достижения\n"
            "🎁 Награда за вход и колесо удачи\n"
            "⭐ Уровни и статистика\n\n"
            "Жми кнопку ниже, чтобы начать!"))
    elif text.startswith("/help"):
        call("sendMessage", chat_id=chat_id, reply_markup=play_keyboard(), text=(
            "Выбери ставку и количество ловушек, нажми «Играть» и открывай плитки. "
            "Каждый кристалл увеличивает множитель — забери выигрыш до того, как попадёшь в ловушку.\n\n"
            "Кристаллы — игровая валюта без реальной стоимости."))


def main():
    me = call("getMe")
    print(f"Бот @{me['username']} запущен. Мини-приложение: {WEBAPP_URL}")
    # Кнопка «Играть» слева от поля ввода во всех чатах с ботом
    call("setChatMenuButton", menu_button={"type": "web_app", "text": "Играть", "web_app": {"url": WEBAPP_URL}})
    call("setMyCommands", commands=[
        {"command": "start", "description": "Начать"},
        {"command": "play", "description": "Открыть игру"},
        {"command": "help", "description": "Как играть"},
    ])
    # Описание, которое Telegram показывает сам, даже когда бот выключен
    try:
        call("setMyDescription", description=(
            "💎 Crystal Mines — открывай плитки, собирай кристаллы и не попадись в ловушку!\n\n"
            "🎯 Миссии и достижения · 🎁 Ежедневные награды · 🎡 Колесо удачи · ⭐ Уровни\n\n"
            "Нажми «Играть» внизу слева, чтобы начать."))
        call("setMyShortDescription", short_description="💎 Мины с кристаллами, миссиями и наградами. Жми «Играть»!")
    except Exception as e:
        print("Описание не обновлено:", e)

    # RUN_SECONDS: сколько секунд работать (для GitHub Actions); 0 = бесконечно
    run_for = int(os.environ.get("RUN_SECONDS", "0") or 0)
    stop_at = time.time() + run_for if run_for else None
    offset = 0
    while stop_at is None or time.time() < stop_at:
        try:
            updates = call("getUpdates", offset=offset, timeout=30, allowed_updates=["message"])
            for u in updates:
                offset = u["update_id"] + 1
                if "message" in u:
                    try:
                        on_message(u["message"])
                    except Exception as e:  # не роняем бота из-за одного сообщения
                        print("Ошибка обработки:", e)
        except (urllib.error.URLError, TimeoutError) as e:
            print("Сеть:", e)
            time.sleep(3)
        except KeyboardInterrupt:
            print("Остановлен")
            break
    # подтверждаем обработанные сообщения, чтобы следующий запуск не ответил на них повторно
    if offset:
        try:
            call("getUpdates", offset=offset, timeout=0)
        except Exception:
            pass
    print("Смена закончена")


if __name__ == "__main__":
    main()
