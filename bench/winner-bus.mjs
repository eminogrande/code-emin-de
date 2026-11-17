/**
 * bus.mjs — a minimal, dependency-free agent message bus on top of `node:sqlite`.
 *
 * Node >= 22 (built-in `node:sqlite` DatabaseSync only). Zero external deps.
 *
 * Design notes:
 *  - Messages live in `messages`; reads are tracked **per agent** in `acks`
 *    (message_id, agent_id) so a broadcast acked by A stays unread for B.
 *  - Full-text search uses FTS5 (unicode61) in external-content mode, kept in
 *    sync by triggers. User queries are tokenised and re-quoted before being
 *    handed to FTS5, so arbitrary punctuation can never trigger a syntax error.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const BROADCAST = '*';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sender     TEXT    NOT NULL,
  recipient  TEXT    NOT NULL,
  topic      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  reply_to   INTEGER REFERENCES messages(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_recipient_id ON messages(recipient, id);
CREATE INDEX IF NOT EXISTS messages_reply_to     ON messages(reply_to);

CREATE TABLE IF NOT EXISTS acks (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id   TEXT    NOT NULL,
  ack_at     INTEGER NOT NULL,
  PRIMARY KEY (message_id, agent_id)
);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(topic, body, content='messages', content_rowid='id', tokenize='unicode61');

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, topic, body) VALUES (new.id, new.topic, new.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, topic, body)
    VALUES ('delete', old.id, old.topic, old.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, topic, body)
    VALUES ('delete', old.id, old.topic, old.body);
  INSERT INTO messages_fts(rowid, topic, body) VALUES (new.id, new.topic, new.body);
END;
`;

/* ------------------------------------------------------------------ helpers */

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value, name) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
  return value;
}

function optionInteger(value, name, fallback) {
  if (value === undefined) value = fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

/**
 * Turn arbitrary user input into a safe FTS5 MATCH expression.
 * Every run of letters/digits/underscore becomes a quoted prefix term.
 * Anything else (quotes, hyphens, colons, apostrophes, parens, `*`, `NEAR`,
 * `AND`, ...) is discarded, so FTS5 can never see syntax it objects to.
 */
export function toMatchExpression(query) {
  if (typeof query !== 'string') throw new TypeError('query must be a string');
  const tokens = query.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens) return '';
  return tokens.map((t) => `"${t}"*`).join(' AND ');
}

/* --------------------------------------------------------------- row mapping */

const toMessage = (r) => ({
  id: r.id,
  from: r.sender,
  to: r.recipient,
  topic: r.topic,
  body: r.body,
  replyTo: r.reply_to ?? null,
  createdAt: r.created_at,
  ackAt: r.ack_at ?? null,
});

const pickSearch = (r) => ({
  id: r.id,
  from: r.sender,
  to: r.recipient,
  topic: r.topic,
  body: r.body,
  replyTo: r.reply_to ?? null,
  createdAt: r.created_at,
});

/* --------------------------------------------------------------------- main */

export function openAgentBus(dbPath) {
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    throw new TypeError('dbPath must be a non-empty string');
  }

  const inMemory = dbPath === ':memory:' || dbPath.startsWith('file::memory:');
  if (!inMemory) {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch {
      /* directory already exists or is not creatable — let sqlite report it */
    }
  }

  const db = new DatabaseSync(dbPath);

  if (!inMemory) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  const hadFts = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
    .get();
  db.exec(FTS_SCHEMA);
  // Backfill FTS for databases created before full-text search existed.
  if (!hadFts) db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");

  const stmt = {
    insert: db.prepare(
      `INSERT INTO messages (sender, recipient, topic, body, reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    ),
    exists: db.prepare('SELECT recipient FROM messages WHERE id = ?'),
    inboxRead: db.prepare(
      `SELECT m.id, m.sender, m.recipient, m.topic, m.body, m.reply_to, m.created_at,
              (SELECT a.ack_at FROM acks a
                WHERE a.message_id = m.id AND a.agent_id = ?1) AS ack_at
         FROM messages m
        WHERE m.id > ?2
          AND (m.recipient = ?1
               OR (m.recipient = '${BROADCAST}' AND m.sender <> ?1))
          AND NOT EXISTS (SELECT 1 FROM acks a
                           WHERE a.message_id = m.id AND a.agent_id = ?1)
        ORDER BY m.id ASC
        LIMIT ?3`,
    ),
    inboxAll: db.prepare(
      `SELECT m.id, m.sender, m.recipient, m.topic, m.body, m.reply_to, m.created_at,
              (SELECT a.ack_at FROM acks a
                WHERE a.message_id = m.id AND a.agent_id = ?1) AS ack_at
         FROM messages m
        WHERE m.id > ?2
          AND (m.recipient = ?1
               OR (m.recipient = '${BROADCAST}' AND m.sender <> ?1))
        ORDER BY m.id ASC
        LIMIT ?3`,
    ),
    ackGet: db.prepare('SELECT ack_at FROM acks WHERE message_id = ? AND agent_id = ?'),
    ackPut: db.prepare(
      `INSERT INTO acks (message_id, agent_id, ack_at) VALUES (?, ?, ?)
       ON CONFLICT (message_id, agent_id) DO NOTHING`,
    ),
    search: db.prepare(
      `SELECT m.id, m.sender, m.recipient, m.topic, m.body, m.reply_to, m.created_at
         FROM messages m
         JOIN (SELECT rowid AS rid, bm25(messages_fts) AS score
                 FROM messages_fts
                WHERE messages_fts MATCH ?1) f
           ON f.rid = m.id
        ORDER BY f.score, m.id DESC
        LIMIT ?2`,
    ),
    thread: db.prepare(
      `WITH RECURSIVE chain(id) AS (
         SELECT id FROM messages WHERE id = ?1
         UNION
         SELECT m.id FROM messages m JOIN chain c ON m.reply_to = c.id
       )
       SELECT m.id, m.sender, m.recipient, m.topic, m.body, m.reply_to, m.created_at
         FROM messages m JOIN chain c ON c.id = m.id
        ORDER BY m.id ASC`,
    ),
  };

  let closed = false;
  const alive = () => {
    if (closed) throw new Error('agent bus is closed');
  };

  function send({ from, to, topic, body, replyTo } = {}) {
    alive();
    requireString(from, 'from');
    requireString(to, 'to');
    requireString(topic, 'topic');
    requireString(body, 'body');

    let parent = null;
    if (replyTo !== undefined && replyTo !== null) {
      requireInteger(replyTo, 'replyTo');
      if (!stmt.exists.get(replyTo)) {
        throw new RangeError(`replyTo message ${replyTo} does not exist`);
      }
      parent = replyTo;
    }

    const createdAt = Date.now();
    const row = stmt.insert.get(from, to, topic, body, parent, createdAt);
    return { id: row.id, from, to, topic, body, replyTo: parent, createdAt, ackAt: null };
  }

  function inbox(agentId, { unreadOnly = true, limit = 50, afterId = 0 } = {}) {
    alive();
    requireString(agentId, 'agentId');
    const max = optionInteger(limit, 'limit', 50);
    const after = optionInteger(afterId, 'afterId', 0);
    if (max === 0) return [];

    const rows = (unreadOnly ? stmt.inboxRead : stmt.inboxAll).all(agentId, after, max);
    return rows.map(toMessage);
  }

  function ack(agentId, messageId) {
    alive();
    requireString(agentId, 'agentId');
    requireInteger(messageId, 'messageId');

    const target = stmt.exists.get(messageId);
    if (!target) throw new RangeError(`message ${messageId} does not exist`);
    if (target.recipient !== BROADCAST && target.recipient !== agentId) {
      throw new Error(
        `message ${messageId} is addressed to "${target.recipient}"; agent "${agentId}" cannot ack it`,
      );
    }

    const existing = stmt.ackGet.get(messageId, agentId);
    if (existing) return { id: messageId, ackAt: existing.ack_at }; // idempotent, original ts

    const ackAt = Date.now();
    stmt.ackPut.run(messageId, agentId, ackAt);
    const settled = stmt.ackGet.get(messageId, agentId); // canonical value on conflict
    return { id: messageId, ackAt: settled ? settled.ack_at : ackAt };
  }

  function search(query, { limit = 20 } = {}) {
    alive();
    if (typeof query !== 'string') throw new TypeError('query must be a string');
    const max = optionInteger(limit, 'limit', 20);
    if (max === 0) return [];

    const match = toMatchExpression(query);
    if (match === '') return [];
    return stmt.search.all(match, max).map(pickSearch);
  }

  function thread(rootId) {
    alive();
    requireInteger(rootId, 'rootId');
    return stmt.thread.all(rootId).map(pickSearch);
  }

  function close() {
    if (closed) return;
    closed = true;
    db.close();
  }

  return { send, inbox, ack, search, thread, close };
}

export default openAgentBus;
