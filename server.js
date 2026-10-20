const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3111;

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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err2) => {
        if (err2) console.error("Errore creazione tabella services:", err2.message);
        seedAndSyncCategories();
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
        stmt.finalize();
    });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API: Ottieni tutti i servizi
app.get('/api/services', (req, res) => {
    db.all("SELECT * FROM services ORDER BY id DESC", [], (err, rows) => {
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
    db.run(
        "INSERT INTO services (name, url, logo, category) VALUES (?, ?, ?, ?)",
        [name, url, logo || '', cat],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, name, url, logo, category: cat });
        }
    );
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