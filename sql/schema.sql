-- Филиалы из HolliHop (GetOffices)
CREATE TABLE IF NOT EXISTS branches (
  id          INT UNSIGNED NOT NULL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  location    VARCHAR(255) NULL,
  address     VARCHAR(500) NULL,
  email       VARCHAR(255) NULL,
  phone       VARCHAR(64)  NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  synced_at   DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ученики (GetStudents)
CREATE TABLE IF NOT EXISTS students (
  client_id   INT UNSIGNED NOT NULL PRIMARY KEY,   -- ClientId в HolliHop
  hh_id       INT UNSIGNED NOT NULL,               -- Id ученика
  first_name  VARCHAR(128) NULL,
  last_name   VARCHAR(128) NULL,
  middle_name VARCHAR(128) NULL,
  birthday    DATE NULL,
  status      VARCHAR(128) NULL,
  mobile      VARCHAR(64)  NULL,
  phone       VARCHAR(64)  NULL,
  email       VARCHAR(255) NULL,
  hh_created  DATETIME NULL,
  hh_updated  DATETIME NULL,
  sync_run    INT UNSIGNED NOT NULL DEFAULT 0,
  synced_at   DATETIME NOT NULL,
  KEY idx_status (status),
  KEY idx_sync_run (sync_run)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ученик <-> филиал
CREATE TABLE IF NOT EXISTS student_branches (
  student_client_id INT UNSIGNED NOT NULL,
  branch_id         INT UNSIGNED NOT NULL,
  PRIMARY KEY (student_client_id, branch_id),
  KEY idx_branch (branch_id),
  CONSTRAINT fk_sb_student FOREIGN KEY (student_client_id) REFERENCES students (client_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Родители / контактные лица (Agents)
CREATE TABLE IF NOT EXISTS agents (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  student_client_id INT UNSIGNED NOT NULL,
  first_name        VARCHAR(128) NULL,
  last_name         VARCHAR(128) NULL,
  middle_name       VARCHAR(128) NULL,
  who_is            VARCHAR(64)  NULL,
  mobile            VARCHAR(64)  NULL,
  phone             VARCHAR(64)  NULL,
  email             VARCHAR(255) NULL,
  is_customer       TINYINT(1) NOT NULL DEFAULT 0,
  KEY idx_agent_student (student_client_id),
  CONSTRAINT fk_agent_student FOREIGN KEY (student_client_id) REFERENCES students (client_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Нормализованные телефоны (последние 10 цифр) для сопоставления с Telegram-контактом
CREATE TABLE IF NOT EXISTS contacts (
  student_client_id INT UNSIGNED NOT NULL,
  owner             ENUM('student','agent') NOT NULL,
  phone_key         CHAR(10) NOT NULL,
  PRIMARY KEY (student_client_id, owner, phone_key),
  KEY idx_phone_key (phone_key),
  CONSTRAINT fk_contact_student FOREIGN KEY (student_client_id) REFERENCES students (client_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Пользователи Telegram, запустившие бота
CREATE TABLE IF NOT EXISTS tg_users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  chat_id       BIGINT NOT NULL,
  username      VARCHAR(64)  NULL,
  first_name    VARCHAR(128) NULL,
  last_name     VARCHAR(128) NULL,
  phone_key     CHAR(10) NULL,
  phone_raw     VARCHAR(32) NULL,
  is_subscribed TINYINT(1) NOT NULL DEFAULT 1,
  is_blocked    TINYINT(1) NOT NULL DEFAULT 0,
  lang          VARCHAR(5) NULL,             -- 'kk' | 'ru'; NULL = язык ещё не выбран (по умолчанию казахский)
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_chat (chat_id),
  KEY idx_phone_key (phone_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Кем пользователь Telegram приходится ученику
CREATE TABLE IF NOT EXISTS tg_links (
  tg_user_id        BIGINT UNSIGNED NOT NULL,
  student_client_id INT UNSIGNED NOT NULL,
  relation          ENUM('student','parent') NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- когда зарегистрировался в боте по этому ученику
  PRIMARY KEY (tg_user_id, student_client_id, relation),
  KEY idx_link_student (student_client_id),
  KEY idx_link_created (created_at),
  CONSTRAINT fk_link_user FOREIGN KEY (tg_user_id) REFERENCES tg_users (id) ON DELETE CASCADE,
  CONSTRAINT fk_link_student FOREIGN KEY (student_client_id) REFERENCES students (client_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Рассылки
CREATE TABLE IF NOT EXISTS broadcasts (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  admin_chat_id  BIGINT NOT NULL,
  src_chat_id    BIGINT NOT NULL,        -- откуда копируем сообщение (copyMessage)
  src_message_id INT NOT NULL,
  audience       ENUM('all','parents','students') NOT NULL DEFAULT 'all',
  all_branches   TINYINT(1) NOT NULL DEFAULT 0,
  status         ENUM('running','done','cancelled','failed') NOT NULL DEFAULT 'running',
  total          INT UNSIGNED NOT NULL DEFAULT 0,
  sent           INT UNSIGNED NOT NULL DEFAULT 0,
  failed         INT UNSIGNED NOT NULL DEFAULT 0,
  blocked        INT UNSIGNED NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at     DATETIME NULL,
  finished_at    DATETIME NULL,
  text           TEXT NULL,               -- текст рассылки из веб-админки (если NULL — copyMessage)
  parse_mode     VARCHAR(16) NULL,
  title          VARCHAR(255) NULL,       -- описание фильтра/получателей
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS broadcast_branches (
  broadcast_id INT UNSIGNED NOT NULL,
  branch_id    INT UNSIGNED NOT NULL,
  PRIMARY KEY (broadcast_id, branch_id),
  CONSTRAINT fk_bb_broadcast FOREIGN KEY (broadcast_id) REFERENCES broadcasts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  broadcast_id INT UNSIGNED NOT NULL,
  chat_id      BIGINT NOT NULL,
  student_client_id INT UNSIGNED NOT NULL DEFAULT 0,  -- 0 = сообщение без привязки к ученику
  student_name VARCHAR(255) NULL,                      -- не NULL => сообщение родителю с обращением по ученику
  status       ENUM('pending','sent','failed','blocked') NOT NULL DEFAULT 'pending',
  error        VARCHAR(255) NULL,
  sent_at      DATETIME NULL,
  UNIQUE KEY uq_bc_chat_student (broadcast_id, chat_id, student_client_id),
  KEY idx_bc_status (broadcast_id, status),
  CONSTRAINT fk_br_broadcast FOREIGN KEY (broadcast_id) REFERENCES broadcasts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sync_state (
  k VARCHAR(64)  NOT NULL PRIMARY KEY,
  v VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
