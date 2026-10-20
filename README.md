<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0b0f19,100:6366f1&height=200&section=header&text=Ghibiri%20Hub&fontSize=58&fontColor=ffffff&animation=fadeIn&fontAlignY=36&desc=Homelab%20Dashboard&descAlignY=58&descSize=18" width="100%" alt="Ghibiri Hub" />

<a href="https://github.com/GabriPy/process.ghibiri.it">
  <img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=20&pause=1200&color=8B9CFF&center=true&vCenter=true&width=620&lines=Self-hosted+homelab+dashboard;Categorie%2C+domini+e+stato+live;Drag+%26+drop%2C+login+con+PIN;Docker-ready+%F0%9F%90%B3" alt="Animated subtitle" />
</a>

<br />

<img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
<img src="https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white" alt="Express" />
<img src="https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite" />
<img src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" />
<img src="https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" alt="Tailwind CSS" />

<br /><br />

**Tutti i tuoi servizi self-hosted in un'unica dashboard.**<br />
Card con pallino di stato live, categorie colorate, domini riutilizzabili e accesso protetto da PIN.

</div>

---

## ✨ Anteprima

<p align="center">
  <img src="docs/preview.svg" width="90%" alt="Anteprima UI" />
</p>

<p align="center"><sub>Mockup illustrativo dell'interfaccia in tema scuro.</sub></p>

## 🚀 Caratteristiche

| | Funzionalità | Descrizione |
|:--|:--|:--|
| 🟢 | **Stato live** | Un pallino su ogni card: verde se il servizio risponde, rosso se è irraggiungibile. |
| 🔐 | **Login con PIN** | Accesso protetto da un PIN a 4 cifre, configurabile via variabile d'ambiente. |
| 🗂️ | **Categorie e domini** | Pagina dedicata per gestire le categorie (nome + colore) e i domini usati negli URL. |
| 🎨 | **Sezioni colorate** | Le card sono raggruppate in sezioni per categoria, con bordo, badge e box icona nel colore scelto. |
| 🖱️ | **Drag & drop** | Trascina le card per riordinarle in ogni sezione: l'ordine viene salvato nel database. |
| 🌐 | **URL componibili** | Nel form scegli protocollo (https di default), nome, sottodominio e dominio da una tendina. |
| 🔤 | **Ordinamento A-Z** | Un toggle annulla il raggruppamento e ordina tutti i servizi alfabeticamente. |
| 🔍 | **Ricerca istantanea** | Filtra per nome o categoria mentre digiti. |
| 🧩 | **Dropdown categoria** | Nel form del servizio scegli la categoria da un menu: una sola per servizio. |
| 🖼️ | **Logo automatici** | Compatibile con [dashboard-icons](https://github.com/walkxcode/dashboard-icons), con fallback locale. |
| 🐳 | **Docker-ready** | Un `docker compose up` e sei online, con database persistente su volume. |

## 🧱 Stack

<div align="center">

| Layer | Tecnologie |
|:--|:--|
| **Backend** | Node.js 20 · Express 4 · SQLite (`sqlite3`) |
| **Frontend** | HTML singolo · Tailwind CSS (CDN) · Font Awesome 6 · JavaScript vanilla |
| **Infra** | Docker · Docker Compose · Alpine Linux |

</div>

## 🗺️ Come funziona

```mermaid
flowchart LR
    B["🖥️ Browser<br/>Dashboard"] -->|"REST /api"| A["⚙️ Express<br/>:3111"]
    A --> D[("🗄️ SQLite<br/>services.db")]
    A -->|"HEAD / GET"| S["🌐 Servizi<br/>homelab"]
    S -.->|"online / offline"| A
    A -.->|"🟢 🔴"| B
```

Il controllo di raggiungibilità avviene **lato server** (endpoint `/api/check`): così si evitano i blocchi CORS del browser e funzionano anche servizi senza header CORS.

## 🐳 Avvio rapido

```bash
git clone https://github.com/GabriPy/process.ghibiri.it.git
cd process.ghibiri.it
AUTH_PIN=4821 docker compose up -d --build
```

Apri **http://localhost:3111** e inserisci il PIN 🎉

Il database viene salvato in `./data/services.db` tramite volume, quindi sopravvive ai riavvii.

## 🔐 Login con PIN

L'accesso è protetto da un **PIN a 4 cifre** letto dalla variabile d'ambiente `AUTH_PIN`:

```yaml
# docker-compose.yml
environment:
  - AUTH_PIN=${AUTH_PIN:-1234}
```

| Comportamento | Dettaglio |
|:--|:--|
| **Sessione** | Token firmato HMAC-SHA256 con scadenza 30 giorni, salvato in un cookie `httpOnly` + `SameSite=Lax`. |
| **Persistenza** | Nessuno stato lato server: la sessione resta valida anche dopo il riavvio del container. |
| **Protezione** | Tutte le API rispondono `401` senza un cookie valido; l'interfaccia mostra la schermata di sblocco. |
| **PIN disattivato** | Se `AUTH_PIN` non è impostata, l'autenticazione viene ignorata (comodo in sviluppo locale). |

Per cambiare il PIN basta rieseguire il compose con un nuovo valore:

```bash
AUTH_PIN=9173 docker compose up -d
```

> Il PIN di default nel compose è `1234`: cambialo prima di esporre la dashboard.

<details>
<summary><b>💻 Avvio in locale (senza Docker)</b></summary>

<br />

```bash
npm ci        # oppure: npm install
npm start
```

Richiede Node.js 20+. La cartella `data/` e il DB vengono creati automaticamente al primo avvio.

</details>

## 🔌 API

| Metodo | Endpoint | Descrizione |
|:--|:--|:--|
| `GET` | `/api/auth` | Stato dell'autenticazione (richiesta / attiva) |
| `POST` | `/api/login` | Login con PIN, imposta il cookie di sessione |
| `POST` | `/api/logout` | Chiude la sessione |
| `GET` | `/api/services` | Elenco servizi, ordinati per posizione |
| `POST` | `/api/services` | Crea un servizio |
| `PUT` | `/api/services/:id` | Modifica un servizio |
| `PUT` | `/api/services/order` | Salva l'ordine delle card (`{ "order": [id, ...] }`) |
| `DELETE` | `/api/services/:id` | Elimina un servizio |
| `GET` | `/api/categories` | Elenco categorie con conteggio servizi |
| `POST` | `/api/categories` | Crea una categoria |
| `PUT` | `/api/categories/:id` | Rinomina / ricolora (aggiorna i servizi collegati) |
| `DELETE` | `/api/categories/:id` | Elimina una categoria (solo se non in uso) |
| `GET` | `/api/domains` | Elenco dei domini |
| `POST` | `/api/domains` | Aggiunge un dominio |
| `PUT` | `/api/domains/:id` | Rinomina un dominio |
| `DELETE` | `/api/domains/:id` | Elimina un dominio |
| `GET` | `/api/check?url=` | Verifica se un servizio è raggiungibile |

Tutte le rotte `/api/*` (tranne `auth` e `login`) richiedono il cookie di sessione.

<details>
<summary><b>Esempio: creare un servizio</b></summary>

<br />

```bash
curl -X POST http://localhost:3111/api/services \
  -H "Content-Type: application/json" \
  -b "ghibiri_session=<cookie>" \
  -d '{
    "name": "Portainer",
    "url": "https://portainer.ghibiri.it",
    "logo": "https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/portainer.png",
    "category": "Gestione"
  }'
```

L'interfaccia compone lo stesso URL partendo da protocollo + sottodominio + dominio, ma l'API accetta qualsiasi `url` completo.

</details>

## 📁 Struttura del progetto

```
process.ghibiri.it/
├── server.js              # API Express + SQLite (servizi, categorie, domini, auth PIN, check)
├── public/
│   ├── index.html         # Dashboard (viste, drag & drop, modali, login, stato live)
│   └── default-icon.svg   # Icona di fallback
├── data/                  # Volume Docker con services.db (ignorato da git)
├── docs/
│   └── preview.svg        # Anteprima animata usata in questo README
├── Dockerfile
├── docker-compose.yml     # Porta 3111, volume dati, variabile AUTH_PIN
└── package.json
```

## 🎨 Icone

I logo dei servizi accettano qualsiasi URL. La lista consigliata è [walkxcode/dashboard-icons](https://github.com/walkxcode/dashboard-icons) — sfogliabile su [dashboardicons.com](https://dashboardicons.com/):

```text
https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/svg/<nome>.svg
https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/<nome>.png
```

Se il logo manca o non carica, la card usa automaticamente `public/default-icon.svg`.

---

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:6366f1,100:0b0f19&height=120&section=footer" width="100%" alt="footer" />

<sub>Fatto con ☕ per il mio homelab · <a href="https://github.com/GabriPy">@GabriPy</a></sub>

</div>
