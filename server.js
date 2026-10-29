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

// --- Inizializzazione del database ---
// Schema, migrazioni e dati iniziali vengono attesi prima di mettere il server
// in ascolto: le API non servono mai una lista parziale durante il primo avvio.
async function initDatabase() {
    try {
        await dbRun(`
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                color TEXT NOT NULL DEFAULT '#6366f1',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await dbRun(`
            CREATE TABLE IF NOT EXISTS services (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                logo TEXT,
                icon TEXT,
                icon_color TEXT,
                category TEXT DEFAULT '${DEFAULT_CATEGORY}',
                position INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Migrazioni per i database creati con versioni precedenti
        await addColumnIfMissing('services', 'position', 'INTEGER');
        await addColumnIfMissing('services', 'icon', 'TEXT');
        await addColumnIfMissing('services', 'icon_color', 'TEXT');
        await dbRun(`
            CREATE TABLE IF NOT EXISTS domains (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Collegamenti a siti esterni (vista "Collegamenti")
        await dbRun(`
            CREATE TABLE IF NOT EXISTS links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                icon TEXT,
                color TEXT,
                category TEXT DEFAULT '',
                position INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Migrazione: categoria dei collegamenti per i database creati prima
        await addColumnIfMissing('links', 'category', 'TEXT');
        await seedAndSyncCategories();
        await migratePositions();
    } catch (err) {
        console.error("Errore inizializzazione database:", err.message);
    }
    startServer();
}

async function addColumnIfMissing(table, column, type) {
    try {
        await dbRun(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (err) {
        // L'errore è atteso quando la colonna esiste già
        if (!String(err.message).includes('duplicate column')) {
            console.error(`Errore migrazione ${table}.${column}:`, err.message);
        }
    }
}

// Inserisce i dati iniziali e allinea la tabella categories ai servizi esistenti
async function seedAndSyncCategories() {
    const row = await dbGet("SELECT COUNT(*) AS count FROM services");
    if (row && row.count === 0) {
        const demo = [
            ["Portainer", "http://localhost:9000", "fa-solid fa-cube", "#6366f1", "Gestione"],
            ["Beszel", "http://localhost:8090", "fa-solid fa-gauge-high", "#22c55e", "Monitoraggio"],
            ["Uptime Kuma", "http://localhost:3001", "fa-solid fa-heart-pulse", "#ec4899", "Monitoraggio"]
        ];
        for (const [name, url, icon, iconColor, category] of demo) {
            await dbRun(
                "INSERT INTO services (name, url, icon, icon_color, category) VALUES (?, ?, ?, ?, ?)",
                [name, url, icon, iconColor, category]
            );
        }
    }
    await syncCategories();
}

// Aggiunge alla tabella categories le categorie usate dai servizi e dai collegamenti
async function syncCategories() {
    const rows = await dbAll(`
        SELECT DISTINCT TRIM(category) AS name FROM services WHERE category IS NOT NULL AND TRIM(category) != ''
        UNION
        SELECT DISTINCT TRIM(category) AS name FROM links WHERE category IS NOT NULL AND TRIM(category) != ''
    `);
    let names = rows.map(r => r.name).filter(Boolean);
    if (names.length === 0) names = [DEFAULT_CATEGORY];
    for (let i = 0; i < names.length; i++) {
        await dbRun("INSERT OR IGNORE INTO categories (name, color) VALUES (?, ?)", [names[i], DEFAULT_COLORS[i % DEFAULT_COLORS.length]]);
    }
}

// Assegna una posizione progressiva ai servizi che non ne hanno ancora una
async function migratePositions() {
    const rows = await dbAll("SELECT id FROM services WHERE position IS NULL ORDER BY id ASC");
    if (rows.length === 0) return;
    const max = await dbGet("SELECT COALESCE(MAX(position), -1) AS maxPos FROM services");
    let next = (max ? max.maxPos : -1) + 1;
    for (const row of rows) {
        await dbRun("UPDATE services SET position = ? WHERE id = ?", [next++, row.id]);
    }
}

// --- Helper promise-based per SQLite (usati da backup/ripristino) ---
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
}

function dbExec(sql) {
    return new Promise((resolve, reject) => {
        db.exec(sql, (err) => err ? reject(err) : resolve());
    });
}

// Accetta solo URL http/https (usato da /api/check e /api/status)
function isHttpUrl(value) {
    try {
        const parsed = new URL(String(value));
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

// Normalizza l'URL di un collegamento: se manca lo schema aggiunge https://
function normalizeUrl(value) {
    const raw = cleanText(value, 2048);
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    // Un altro schema esplicito (ftp://, mailto:...) viene lasciato a isHttpUrl, che lo rifiuta
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
    return 'https://' + raw.replace(/^\/+/, '');
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));
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
    const { name, url, logo, icon, icon_color, category } = req.body;
    if (!name || !url) {
        return res.status(400).json({ error: "Nome e URL sono obbligatori" });
    }
    const cat = category || 'Generale';
    db.get("SELECT COALESCE(MAX(position), -1) + 1 AS nextPos FROM services", [], (err, row) => {
        const nextPos = err ? 0 : row.nextPos;
        db.run(
            "INSERT INTO services (name, url, logo, icon, icon_color, category, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [name, url, logo || '', icon || '', icon_color || '', cat, nextPos],
            function (err2) {
                if (err2) return res.status(500).json({ error: err2.message });
                res.json({ id: this.lastID, name, url, logo, icon, icon_color, category: cat, position: nextPos });
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
    const { name, url, logo, icon, icon_color, category } = req.body;
    const { id } = req.params;
    db.run(
        "UPDATE services SET name = ?, url = ?, logo = ?, icon = ?, icon_color = ?, category = ? WHERE id = ?",
        [name, url, logo || '', icon || '', icon_color || '', category || 'Generale', id],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ updated: this.changes });
        }
    );
});

// API: Ottieni tutte le categorie (con conteggio servizi e collegamenti)
app.get('/api/categories', (req, res) => {
    db.all(`
        SELECT c.id, c.name, c.color,
            (SELECT COUNT(*) FROM services s WHERE s.category = c.name) AS count,
            (SELECT COUNT(*) FROM links l WHERE l.category = c.name) AS link_count
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
                    // La rinomina vale anche per i collegamenti che usano la categoria
                    db.run("UPDATE services SET category = ? WHERE category = ?", [newName, oldName]);
                    db.run("UPDATE links SET category = ? WHERE category = ?", [newName, oldName]);
                }
                res.json({ updated: this.changes });
            }
        );
    });
});

// API: Elimina categoria (solo se non usata da nessun servizio o collegamento)
app.delete('/api/categories/:id', (req, res) => {
    const { id } = req.params;
    db.get("SELECT name FROM categories WHERE id = ?", [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Categoria non trovata" });
        db.get(`
            SELECT (SELECT COUNT(*) FROM services WHERE category = ?) +
                   (SELECT COUNT(*) FROM links WHERE category = ?) AS count
        `, [row.name, row.name], (err2, c) => {
            if (err2) return res.status(500).json({ error: err2.message });
            if (c.count > 0) {
                return res.status(409).json({
                    error: `Impossibile eliminare: categoria usata da ${c.count} ${c.count === 1 ? 'elemento' : 'elementi'}`
                });
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

// --- Collegamenti a siti esterni ---
function linkPayload(body) {
    const source = body || {};
    return {
        name: cleanText(source.name, 120),
        url: normalizeUrl(source.url),
        icon: cleanText(source.icon, 120),
        // Il colore non è più usato dall'interfaccia: le card seguono il colore della categoria.
        // Il campo resta per compatibilità con backup e client precedenti.
        color: HEX_COLOR.test(String(source.color || '')) ? String(source.color) : '',
        category: cleanText(source.category, 60)
    };
}

// Garantisce che la categoria usata da un collegamento esista nella tabella categories
async function ensureCategory(name) {
    if (!name) return;
    const existing = await dbGet("SELECT id FROM categories WHERE name = ?", [name]);
    if (existing) return;
    const countRow = await dbGet("SELECT COUNT(*) AS count FROM categories");
    const color = DEFAULT_COLORS[(countRow ? countRow.count : 0) % DEFAULT_COLORS.length];
    await dbRun("INSERT OR IGNORE INTO categories (name, color) VALUES (?, ?)", [name, color]);
}

// API: Elenco collegamenti
app.get('/api/links', async (req, res) => {
    try {
        const rows = await dbAll("SELECT id, name, url, icon, color, COALESCE(category, '') AS category, position FROM links ORDER BY position ASC, name COLLATE NOCASE ASC");
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Aggiungi collegamento
app.post('/api/links', async (req, res) => {
    const link = linkPayload(req.body);
    if (!link.name) return res.status(400).json({ error: "Il nome del collegamento è obbligatorio" });
    if (!isHttpUrl(link.url)) return res.status(400).json({ error: "URL del collegamento non valido" });
    try {
        const row = await dbGet("SELECT COALESCE(MAX(position), -1) + 1 AS nextPos FROM links");
        const nextPos = row ? row.nextPos : 0;
        const result = await dbRun(
            "INSERT INTO links (name, url, icon, color, category, position) VALUES (?, ?, ?, ?, ?, ?)",
            [link.name, link.url, link.icon, link.color, link.category, nextPos]
        );
        await ensureCategory(link.category);
        res.json({ id: result.lastID, ...link, position: nextPos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Modifica collegamento
app.put('/api/links/:id', async (req, res) => {
    const link = linkPayload(req.body);
    if (!link.name) return res.status(400).json({ error: "Il nome del collegamento è obbligatorio" });
    if (!isHttpUrl(link.url)) return res.status(400).json({ error: "URL del collegamento non valido" });
    try {
        const result = await dbRun(
            "UPDATE links SET name = ?, url = ?, icon = ?, color = ?, category = ? WHERE id = ?",
            [link.name, link.url, link.icon, link.color, link.category, req.params.id]
        );
        if (!result.changes) return res.status(404).json({ error: "Collegamento non trovato" });
        await ensureCategory(link.category);
        res.json({ updated: result.changes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Elimina collegamento
app.delete('/api/links/:id', async (req, res) => {
    try {
        const result = await dbRun("DELETE FROM links WHERE id = ?", [req.params.id]);
        if (!result.changes) return res.status(404).json({ error: "Collegamento non trovato" });
        res.json({ deleted: result.changes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Verifica raggiungibilità dei servizi ---
const STATUS_TTL = 30 * 1000;          // una verifica resta valida 30 secondi
const STATUS_TIMEOUT = 5000;           // timeout per singolo servizio
const STATUS_CONCURRENCY = 6;          // richieste in parallelo verso i servizi
const STATUS_MAX_CACHE = 500;
const statusCache = new Map();         // url -> { online, at }

async function probeUrl(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STATUS_TIMEOUT);
    try {
        let response;
        try {
            response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
        } catch (headErr) {
            response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
        }
        // Un 5xx (es. 502/504 dei Cloudflare Tunnel non connessi) significa origine non raggiungibile
        return { online: response.status < 500 };
    } catch (err) {
        return { online: false };
    } finally {
        clearTimeout(timeout);
    }
}

// API: Verifica raggiungibilità di un singolo servizio (mantenuta per compatibilità)
app.get('/api/check', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "URL mancante" });
    if (!isHttpUrl(url)) return res.status(400).json({ error: "URL non valido" });
    const result = await probeUrl(url);
    res.json(result);
});

// API: Verifica di più servizi in una sola richiesta, con cache lato server
app.post('/api/status', async (req, res) => {
    const input = Array.isArray(req.body && req.body.urls) ? req.body.urls : [];
    const urls = [...new Set(input.map(u => String(u)))].filter(isHttpUrl).slice(0, 200);
    if (urls.length === 0) return res.json({ statuses: {}, checkedAt: Date.now() });

    const now = Date.now();
    const statuses = {};
    const pending = [];
    urls.forEach(url => {
        const hit = statusCache.get(url);
        if (hit && now - hit.at < STATUS_TTL) statuses[url] = { online: hit.online, cached: true };
        else pending.push(url);
    });

    let index = 0;
    const worker = async () => {
        while (index < pending.length) {
            const url = pending[index++];
            const probe = await probeUrl(url);
            statusCache.set(url, { online: probe.online, at: Date.now() });
            statuses[url] = { online: probe.online, cached: false };
        }
    };
    await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, pending.length) }, worker));

    // Evita che la cache cresca senza limite quando i servizi cambiano URL
    if (statusCache.size > STATUS_MAX_CACHE) statusCache.clear();

    res.json({ statuses, checkedAt: Date.now() });
});

// API: Elimina servizio
app.delete('/api/services/:id', (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM services WHERE id = ?", [id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deleted: this.changes });
    });
});

// --- Backup / ripristino dei dati ---
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function cleanText(value, maxLength) {
    return String(value == null ? '' : value).trim().slice(0, maxLength);
}

// API: Esporta servizi, categorie, domini e collegamenti in un unico JSON
app.get('/api/backup', async (req, res) => {
    try {
        const [categories, domains, services, links] = await Promise.all([
            dbAll("SELECT id, name, color FROM categories ORDER BY id ASC"),
            dbAll("SELECT id, name FROM domains ORDER BY id ASC"),
            dbAll("SELECT id, name, url, logo, icon, icon_color, category, position FROM services ORDER BY position ASC, id ASC"),
            dbAll("SELECT id, name, url, icon, color, category, position FROM links ORDER BY position ASC, id ASC")
        ]);
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            app: 'ghibiri-hub',
            version: 2,
            exportedAt: new Date().toISOString(),
            categories,
            domains,
            services,
            links
        });
    } catch (err) {
        console.error("Errore export backup:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// API: Ripristina un backup. ?mode=replace (default) svuota e riscrive, ?mode=merge aggiunge solo i mancanti
// In replace vengono svuotate solo le sezioni presenti nel file: un backup vecchio (senza "links")
// non cancella i collegamenti già salvati.
app.post('/api/restore', async (req, res) => {
    const mode = req.query.mode === 'merge' ? 'merge' : 'replace';
    const body = req.body || {};
    const hasServices = Array.isArray(body.services);
    const hasCategories = Array.isArray(body.categories);
    const hasDomains = Array.isArray(body.domains);
    const hasLinks = Array.isArray(body.links);
    if (!hasServices && !hasCategories && !hasDomains && !hasLinks) {
        return res.status(400).json({ error: "File di backup non valido" });
    }

    const categories = (hasCategories ? body.categories : [])
        .map(c => ({
            id: Number.isInteger(c && c.id) ? c.id : null,
            name: cleanText(c && c.name, 60),
            color: HEX_COLOR.test(String((c && c.color) || '')) ? String(c.color) : DEFAULT_COLORS[0]
        }))
        .filter(c => c.name);

    const domains = (hasDomains ? body.domains : [])
        .map(d => ({
            id: Number.isInteger(d && d.id) ? d.id : null,
            name: normalizeDomain(d && d.name)
        }))
        .filter(d => d.name);

    const services = (hasServices ? body.services : [])
        .map((s, index) => ({
            name: cleanText(s && s.name, 120),
            url: cleanText(s && s.url, 2048),
            logo: cleanText(s && s.logo, 2048),
            icon: cleanText(s && s.icon, 120),
            icon_color: HEX_COLOR.test(String((s && s.icon_color) || '')) ? String(s.icon_color) : '',
            category: cleanText(s && s.category, 60) || DEFAULT_CATEGORY,
            position: Number.isFinite(s && s.position) ? Math.trunc(s.position) : index
        }))
        .filter(s => s.name && isHttpUrl(s.url));

    const links = (hasLinks ? body.links : [])
        .map((l, index) => ({
            name: cleanText(l && l.name, 120),
            url: normalizeUrl(l && l.url),
            icon: cleanText(l && l.icon, 120),
            color: HEX_COLOR.test(String((l && l.color) || '')) ? String(l.color) : '',
            category: cleanText(l && l.category, 60),
            position: Number.isFinite(l && l.position) ? Math.trunc(l.position) : index
        }))
        .filter(l => l.name && isHttpUrl(l.url));

    const imported = { categories: 0, domains: 0, services: 0, links: 0 };

    try {
        await dbExec('BEGIN TRANSACTION');

        if (mode === 'replace') {
            if (hasServices) await dbRun('DELETE FROM services');
            if (hasCategories) await dbRun('DELETE FROM categories');
            if (hasDomains) await dbRun('DELETE FROM domains');
            if (hasLinks) await dbRun('DELETE FROM links');
        }

        for (const c of categories) {
            const result = (mode === 'replace' && c.id != null)
                ? await dbRun('INSERT OR REPLACE INTO categories (id, name, color) VALUES (?, ?, ?)', [c.id, c.name, c.color])
                : await dbRun('INSERT OR IGNORE INTO categories (name, color) VALUES (?, ?)', [c.name, c.color]);
            imported.categories += result.changes;
        }

        for (const d of domains) {
            const result = (mode === 'replace' && d.id != null)
                ? await dbRun('INSERT OR REPLACE INTO domains (id, name) VALUES (?, ?)', [d.id, d.name])
                : await dbRun('INSERT OR IGNORE INTO domains (name) VALUES (?)', [d.name]);
            imported.domains += result.changes;
        }

        const positionRow = await dbGet('SELECT COALESCE(MAX(position), -1) AS maxPos FROM services');
        let nextPosition = (positionRow ? positionRow.maxPos : -1) + 1;

        for (const s of services) {
            if (mode === 'merge') {
                const exists = await dbGet('SELECT id FROM services WHERE url = ? AND name = ?', [s.url, s.name]);
                if (exists) continue;
            }
            const result = await dbRun(
                'INSERT INTO services (name, url, logo, icon, icon_color, category, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [s.name, s.url, s.logo, s.icon, s.icon_color, s.category, mode === 'replace' ? s.position : nextPosition++]
            );
            imported.services += result.changes;
        }

        const linkPositionRow = await dbGet('SELECT COALESCE(MAX(position), -1) AS maxPos FROM links');
        let nextLinkPosition = (linkPositionRow ? linkPositionRow.maxPos : -1) + 1;

        for (const l of links) {
            if (mode === 'merge') {
                const exists = await dbGet('SELECT id FROM links WHERE url = ? AND name = ?', [l.url, l.name]);
                if (exists) continue;
            }
            const result = await dbRun(
                'INSERT INTO links (name, url, icon, color, category, position) VALUES (?, ?, ?, ?, ?, ?)',
                [l.name, l.url, l.icon, l.color, l.category, mode === 'replace' ? l.position : nextLinkPosition++]
            );
            imported.links += result.changes;
        }

        // Ogni categoria usata da un servizio o da un collegamento deve esistere in categories
        const usedCategories = await dbAll(`
            SELECT DISTINCT TRIM(category) AS name FROM services WHERE category IS NOT NULL AND TRIM(category) != ''
            UNION
            SELECT DISTINCT TRIM(category) AS name FROM links WHERE category IS NOT NULL AND TRIM(category) != ''
        `);
        for (let i = 0; i < usedCategories.length; i++) {
            await dbRun('INSERT OR IGNORE INTO categories (name, color) VALUES (?, ?)', [
                usedCategories[i].name,
                DEFAULT_COLORS[i % DEFAULT_COLORS.length]
            ]);
        }

        await dbExec('COMMIT');
        res.json({ ok: true, mode, imported });
    } catch (err) {
        await dbExec('ROLLBACK').catch(() => { });
        console.error("Errore ripristino backup:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Il server parte solo a database inizializzato: così le API non servono
// mai una lista parziale durante il primo avvio (seed e migrazioni).
let serverStarted = false;

function startServer() {
    if (serverStarted) return;
    serverStarted = true;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Ghibiri Hub attivo su http://0.0.0.0:${PORT}`);
    });
}

initDatabase();