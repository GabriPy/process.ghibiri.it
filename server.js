const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3111;

// PIN a 4 cifre configurabile da env. Se non impostato, l'autenticazione è disattivata.
const AUTH_PIN = (process.env.AUTH_PIN || '').trim();
const COOKIE_NAME = 'ghibiri_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 giorni

// Assicurati che la cartella data esista
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Inizializza SQLite
const dbPath = path.join(dataDir, 'services.db');
const db = new sqlite3.Database(dbPath);

const DEFAULT_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7', '#ef4444', '#14b8a6', '#f97316', '#3b82f6'];
const DEFAULT_CATEGORY = 'Generale';

db.run(`
    CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL DEFAULT '#6366f1',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`, (err) => {
    if (err) console.error("Errore creazione tabella categories:", err.message);

    db.run(`
        CREATE TABLE IF NOT EXISTS services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            logo TEXT,
            category TEXT DEFAULT '${DEFAULT_CATEGORY}',
            position INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err2) => {
        if (err2) console.error("Errore creazione tabella services:", err2.message);
        // Migrazione: aggiunge la colonna position ai database già esistenti (l'errore è atteso se già presente)
        db.run("ALTER TABLE services ADD COLUMN position INTEGER", (err3) => {
            if (err3 && !String(err3.message).includes('duplicate column')) {
                console.error("Errore migrazione colonna position:", err3.message);
            }
            db.run(`
                CREATE TABLE IF NOT EXISTS domains (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err4) => {
                if (err4) console.error("Errore creazione tabella domains:", err4.message);
                seedAndSyncCategories();
            });
        });
    });
});

// Inserisce i dati iniziali e allinea la tabella categories ai servizi esistenti
function seedAndSyncCategories() {
    db.get("SELECT COUNT(*) AS count FROM services", (err, row) => {
        if (!err && row.count === 0) {
            const stmt = db.prepare("INSERT INTO services (name, url, logo, category) VALUES (?, ?, ?, ?)");
            stmt.run("Portainer", "http://localhost:9000", "https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/portainer.png", "Gestione");
            stmt.run("Beszel", "http://localhost:8090", "https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/beszel.png", "Monitoraggio");
            stmt.run("Uptime Kuma", "http://localhost:3001", "https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/uptime-kuma.png", "Monitoraggio");
            stmt.finalize(() => syncCategories());
        } else {
            syncCategories();
        }
    });
}

// Aggiunge alla tabella categories le categorie usate dai servizi ma non ancora registrate
function syncCategories() {
    db.all("SELECT DISTINCT TRIM(category) AS name FROM services WHERE category IS NOT NULL AND TRIM(category) != '' ORDER BY name", [], (err, rows) => {
        let names = err ? [] : rows.map(r => r.name);
        if (names.length === 0) names = [DEFAULT_CATEGORY];
        const stmt = db.prepare("INSERT OR IGNORE INTO categories (name, color) VALUES (?, ?)");
        names.forEach((n, i) => stmt.run(n, DEFAULT_COLORS[i % DEFAULT_COLORS.length]));
        stmt.finalize(() => migratePositions());
    });
}

// Assegna una posizione progressiva ai servizi che non ne hanno ancora una
function migratePositions() {
    db.all("SELECT id FROM services WHERE position IS NULL ORDER BY id ASC", [], (err, rows) => {
        if (err || rows.length === 0) return;
        db.get("SELECT COALESCE(MAX(position), -1) AS maxPos FROM services", [], (err2, r) => {
            let next = (err2 ? -1 : r.maxPos) + 1;
            const stmt = db.prepare("UPDATE services SET position = ? WHERE id = ?");
            rows.forEach(row => stmt.run(next++, row.id));
            stmt.finalize();
        });
    });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Autenticazione tramite PIN (token firmato con HMAC, nessuno stato lato server) ---
function signSession(expiry) {
    return crypto.createHmac('sha256', AUTH_PIN).update(String(expiry)).digest('hex');
}

function createSessionToken() {
    const expiry = Date.now() + SESSION_TTL;
    return `${expiry}.${signSession(expiry)}`;
}

function verifySessionToken(token) {
    if (!token) return false;
    const [expiry, signature] = token.split('.');
    if (!expiry || !signature) return false;
    const expected = signSession(expiry);
    if (signature.length !== expected.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
    return Number(expiry) > Date.now();
}

function parseCookies(req) {
    const cookies = {};
    (req.headers.cookie || '').split(';').forEach(part => {
        const i = part.indexOf('=');
        if (i > -1) cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
    return cookies;
}

function isAuthenticated(req) {
    return !AUTH_PIN || verifySessionToken(parseCookies(req)[COOKIE_NAME]);
}

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// API: stato autenticazione
app.get('/api/auth', (req, res) => {
    res.json({ required: !!AUTH_PIN, authenticated: isAuthenticated(req) });
});

// API: login con PIN
app.post('/api/login', (req, res) => {
    if (!AUTH_PIN) return res.json({ ok: true });
    const pin = String((req.body && req.body.pin) || '');
    if (!safeEqual(pin, AUTH_PIN)) {
        return res.status(401).json({ error: "PIN errato" });
    }
    res.cookie(COOKIE_NAME, createSessionToken(), {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: SESSION_TTL,
        path: '/'
    });
    res.json({ ok: true });
});

// API: logout
app.post('/api/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
});

// Tutte le altre API richiedono l'autenticazione
app.use('/api', (req, res, next) => {
    if (isAuthenticated(req)) return next();
    res.status(401).json({ error: "Non autorizzato" });
});

// API: Ottieni tutti i servizi
app.get('/api/services', (req, res) => {
    db.all("SELECT * FROM services ORDER BY position ASC, id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// API: Aggiungi servizio
app.post('/api/services', (req, res) => {
    const { name, url, logo, category } = req.body;
    if (!name || !url) {
        return res.status(400).json({ error: "Nome e URL sono obbligatori" });
    }
    const cat = category || 'Generale';
    db.get("SELECT COALESCE(MAX(position), -1) + 1 AS nextPos FROM services", [], (err, row) => {
        const nextPos = err ? 0 : row.nextPos;
        db.run(
            "INSERT INTO services (name, url, logo, category, position) VALUES (?, ?, ?, ?, ?)",
            [name, url, logo || '', cat, nextPos],
            function (err2) {
                if (err2) return res.status(500).json({ error: err2.message });
                res.json({ id: this.lastID, name, url, logo, category: cat, position: nextPos });
            }
        );
    });
});

// API: Salva l'ordine personalizzato dei servizi (drag and drop)
app.put('/api/services/order', (req, res) => {
    const { order } = req.body || {};
    if (!Array.isArray(order) || order.length === 0) {
        return res.status(400).json({ error: "Lista ordine mancante" });
    }
    const stmt = db.prepare("UPDATE services SET position = ? WHERE id = ?");
    db.exec("BEGIN TRANSACTION", (beginErr) => {
        if (beginErr) return res.status(500).json({ error: beginErr.message });
        order.forEach((id, i) => stmt.run(i, Number(id)));
        stmt.finalize((err) => {
            if (err) {
                return db.exec("ROLLBACK", () => res.status(500).json({ error: err.message }));
            }
            db.exec("COMMIT", (commitErr) => {
                if (commitErr) return res.status(500).json({ error: commitErr.message });
                res.json({ updated: order.length });
            });
        });
    });
});

// API: Modifica servizio
app.put('/api/services/:id', (req, res) => {
    const { name, url, logo, category } = req.body;
    const { id } = req.params;
    db.run(
        "UPDATE services SET name = ?, url = ?, logo = ?, category = ? WHERE id = ?",
        [name, url, logo || '', category || 'Generale', id],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ updated: this.changes });
        }
    );
});

// API: Ottieni tutte le categorie (con conteggio servizi)
app.get('/api/categories', (req, res) => {
    db.all(`
        SELECT c.id, c.name, c.color,
            (SELECT COUNT(*) FROM services s WHERE s.category = c.name) AS count
        FROM categories c
        ORDER BY c.name COLLATE NOCASE ASC
    `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// API: Aggiungi categoria
app.post('/api/categories', (req, res) => {
    const { name, color } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: "Il nome della categoria è obbligatorio" });
    }
    db.run(
        "INSERT INTO categories (name, color) VALUES (?, ?)",
        [name.trim(), color || DEFAULT_COLORS[0]],
        function (err) {
            if (err) {
                if (String(err.message).includes('UNIQUE')) {
                    return res.status(409).json({ error: "Categoria già esistente" });
                }
                return res.status(500).json({ error: err.message });
            }
            res.json({ id: this.lastID, name: name.trim(), color: color || DEFAULT_COLORS[0] });
        }
    );
});

// API: Modifica categoria (rinomina e/o cambia colore, aggiornando i servizi collegati)
app.put('/api/categories/:id', (req, res) => {
    const { name, color } = req.body;
    const { id } = req.params;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: "Il nome della categoria è obbligatorio" });
    }
    const newName = name.trim();
    db.get("SELECT name FROM categories WHERE id = ?", [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Categoria non trovata" });
        const oldName = row.name;
        db.run(
            "UPDATE categories SET name = ?, color = ? WHERE id = ?",
            [newName, color || DEFAULT_COLORS[0], id],
            function (err2) {
                if (err2) {
                    if (String(err2.message).includes('UNIQUE')) {
                        return res.status(409).json({ error: "Categoria già esistente" });
                    }
                    return res.status(500).json({ error: err2.message });
                }
                if (oldName !== newName) {
                    db.run("UPDATE services SET category = ? WHERE category = ?", [newName, oldName]);
                }
                res.json({ updated: this.changes });
            }
        );
    });
});

// API: Elimina categoria (solo se non usata da nessun servizio)
app.delete('/api/categories/:id', (req, res) => {
    const { id } = req.params;
    db.get("SELECT name FROM categories WHERE id = ?", [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Categoria non trovata" });
        db.get("SELECT COUNT(*) AS count FROM services WHERE category = ?", [row.name], (err2, c) => {
            if (err2) return res.status(500).json({ error: err2.message });
            if (c.count > 0) {
                return res.status(409).json({ error: `Impossibile eliminare: categoria usata da ${c.count} servizi` });
            }
            db.run("DELETE FROM categories WHERE id = ?", [id], function (err3) {
                if (err3) return res.status(500).json({ error: err3.message });
                res.json({ deleted: this.changes });
            });
        });
    });
});

// Normalizza un dominio: rimuove schema, slash, spazi e punti iniziali/finali
function normalizeDomain(value) {
    return String(value || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '')
        .replace(/^\.+|\.+$/g, '')
        .toLowerCase();
}

// API: Ottieni tutti i domini
app.get('/api/domains', (req, res) => {
    db.all("SELECT id, name FROM domains ORDER BY name COLLATE NOCASE ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// API: Aggiungi dominio
app.post('/api/domains', (req, res) => {
    const name = normalizeDomain(req.body && req.body.name);
    if (!name) return res.status(400).json({ error: "Il dominio è obbligatorio" });
    db.run("INSERT INTO domains (name) VALUES (?)", [name], function (err) {
        if (err) {
            if (String(err.message).includes('UNIQUE')) {
                return res.status(409).json({ error: "Dominio già esistente" });
            }
            return res.status(500).json({ error: err.message });
        }
        res.json({ id: this.lastID, name });
    });
});

// API: Rinomina dominio
app.put('/api/domains/:id', (req, res) => {
    const name = normalizeDomain(req.body && req.body.name);
    if (!name) return res.status(400).json({ error: "Il dominio è obbligatorio" });
    db.run("UPDATE domains SET name = ? WHERE id = ?", [name, req.params.id], function (err) {
        if (err) {
            if (String(err.message).includes('UNIQUE')) {
                return res.status(409).json({ error: "Dominio già esistente" });
            }
            return res.status(500).json({ error: err.message });
        }
        res.json({ updated: this.changes });
    });
});

// API: Elimina dominio
app.delete('/api/domains/:id', (req, res) => {
    db.run("DELETE FROM domains WHERE id = ?", [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deleted: this.changes });
    });
});

// API: Verifica raggiungibilità di un servizio
app.get('/api/check', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "URL mancante" });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        try {
            await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
        } catch (headErr) {
            await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
        }
        res.json({ online: true });
    } catch (err) {
        res.json({ online: false });
    } finally {
        clearTimeout(timeout);
    }
});

// API: Elimina servizio
app.delete('/api/services/:id', (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM services WHERE id = ?", [id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deleted: this.changes });
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Ghibiri Hub attivo su http://0.0.0.0:${PORT}`);
});