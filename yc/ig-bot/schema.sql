-- Схема YDB для Instagram-бота (выполнить в консоли YDB → Запросы).
-- Таблицы полностью отдельные от таблиц записи (slots/windows/bookings/
-- push_subscriptions) — существующая схема не меняется.

-- Ключевые слова и тексты ответов. Управляются из вкладки «Instagram» в админке.
CREATE TABLE ig_triggers (
    id Utf8 NOT NULL,
    keyword Utf8,          -- ключевое слово в нижнем регистре, например "ноты"
    reply_text Utf8,       -- текст личного сообщения (до 900 символов)
    enabled Uint32,        -- 1 включён | 0 выключен
    hits Uint64,           -- сколько раз сработал
    created_at Uint64,     -- ms epoch
    PRIMARY KEY (id)
);

-- Дедупликация: Meta иногда присылает вебхук по одному комментарию повторно.
CREATE TABLE ig_replied (
    comment_id Utf8 NOT NULL,
    trigger_id Utf8,
    user_id Utf8,          -- IGSID автора комментария
    media_id Utf8,
    created_at Uint64,     -- ms epoch
    PRIMARY KEY (comment_id)
);

-- Долгоживущий access-токен (одна строка, id = 'default').
-- Первый токен вставляется вручную, дальше функция продлевает его по таймеру.
CREATE TABLE ig_token (
    id Utf8 NOT NULL,      -- всегда 'default'
    access_token Utf8,
    ig_user_id Utf8,       -- id бизнес-аккаунта Instagram
    expires_at Uint64,     -- ms epoch, когда токен протухнет
    refreshed_at Uint64,   -- ms epoch последнего продления
    PRIMARY KEY (id)
);
