"use strict";

const session = require("express-session");

class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.upsert = database.prepare(`
      INSERT INTO sessions (sid, expires_at, data) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data
    `);
    this.getRecord = database.prepare("SELECT data FROM sessions WHERE sid = ? AND expires_at > ?");
    this.remove = database.prepare("DELETE FROM sessions WHERE sid = ?");
    this.prune = database.prepare("DELETE FROM sessions WHERE expires_at <= ?");
  }

  get(sid, callback) {
    try {
      const record = this.getRecord.get(sid, Date.now());
      callback(null, record ? JSON.parse(record.data) : null);
    } catch (error) {
      callback(error);
    }
  }

  set(sid, value, callback = () => {}) {
    try {
      const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 86400000;
      this.upsert.run(sid, expiresAt, JSON.stringify(value));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, value, callback = () => {}) {
    this.set(sid, value, callback);
  }

  destroy(sid, callback = () => {}) {
    try {
      this.remove.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  clearExpired() {
    this.prune.run(Date.now());
  }
}

module.exports = SQLiteSessionStore;
