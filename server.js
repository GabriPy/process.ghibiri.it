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

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            logo TEXT,
            category TEXT DEFAULT 'Generale',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Inserisci dati iniziali di esempio se il DB è vuoto
    db.get("SELECT COUNT(*) AS count FROM services", (err, row) => {
        if (!err && row.count === 0) {
            const stmt = db.prepare("INSERT INTO services (name, url, logo, category) VALUES (?, ?, ?, ?)");
            stmt.run("Portainer", "http://localhost:9000", "https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/portainer.png", "Gestione");
            stmt.run("Beszel", "http://localhost:8090", "https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/beszel.png", "Monitoraggio");
            stmt.run("Uptime Kuma", "http://localhost:3001", "https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/uptime-kuma.png", "Monitoraggio");
            stmt.finalize();
        }
    });
});

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