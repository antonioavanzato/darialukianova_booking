-- Схема YDB для системы записи (выполнить в консоли YDB → Запросы)

CREATE TABLE slots (
    id Utf8 NOT NULL,
    date Utf8,             -- YYYY-MM-DD
    time Utf8,             -- HH:MM
    direction Utf8,
    duration_min Uint32,
    status Utf8,           -- free | hold | booked
    created_at Uint64,     -- ms epoch
    PRIMARY KEY (id)
);

-- Окна доступности Даши (интервалы времени, которые она открывает).
-- Клиентские занятия нарезаются внутри свободных участков этих окон.
CREATE TABLE windows (
    id Utf8 NOT NULL,
    date Utf8,             -- YYYY-MM-DD
    start_min Uint32,      -- минуты от полуночи
    end_min Uint32,
    created_at Uint64,     -- ms epoch
    PRIMARY KEY (id)
);

CREATE TABLE push_subscriptions (
    id Utf8 NOT NULL,      -- sha256(endpoint)
    endpoint Utf8,
    p256dh Utf8,
    auth Utf8,
    created_at Uint64,     -- ms epoch
    PRIMARY KEY (id)
);

CREATE TABLE bookings (
    id Utf8 NOT NULL,
    slot_id Utf8,
    direction Utf8,
    name Utf8,
    phone Utf8,
    telegram Utf8,
    comment Utf8,
    status Utf8,           -- pending | confirmed | cancelled
    slot_date Utf8,
    slot_time Utf8,
    created_at Uint64,     -- ms epoch
    PRIMARY KEY (id)
);
