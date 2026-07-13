# 🛡️ AuditSym — AI-Assisted Cybersecurity Audit & GRC Platform

<div align="center">

**A local-first, multi-framework GRC intelligence platform with AI-powered auditing, risk remediation, and continuous improvement tracking.**

[![Version](https://img.shields.io/badge/version-2.0.1-blue.svg)](https://github.com/tuusuario/auditsym/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-green.svg)](LICENSE)
[![Frameworks](https://img.shields.io/badge/frameworks-NIST%20%7C%20ISO%20%7C%20CIS%20%7C%20COBIT-purple.svg)](#supported-frameworks)
[![AI Providers](https://img.shields.io/badge/AI-Local%20%26%20Cloud%20Ready-yellow.svg)](#ai-providers)
[![Privacy](https://img.shields.io/badge/Privacy-100%25%20Local%20First-orange.svg)](#privacy--security)

[🚀 Live Demo]((https://github.com/SUALBA/AudiNist_Pro/) 
[📖 Documentation](docs/) · 
[🐛 Report Bug](https://github.com/SUALBA/AudiNist_Pro/issues) · 
[💡 Request Feature](https://github.com/SUALBA/AudiNist_Pro/issues) ·

</div>

---

## 👥 Core Contributors

AuditSym is actively developed and architected by:

#### 👩‍💻 Project Creator  · Product Vision 
**Susana Alba Santamaria** 
UX · Audit Methodology  · Product Vision 
Cybersecurity & Audit-Focused Builder  
 sualba.dev@gmail.com

####  Main Collaborator & Architecture Contributor
**Vandan Panwala**  
Cybersecurity . Software Engineering & Contributor Core Engineering 
🔗 [GitHub Profile](https://github.com/PanwalaVandan)

---

## 🎯 Overview

AuditSym is a comprehensive, **local-first GRC (Governance, Risk & Compliance) intelligence platform** designed for professional auditors, security teams, and compliance officers. It transforms the complexity of cybersecurity frameworks into a practical, visual, and AI-assisted workflow.

Unlike traditional cloud-based GRC tools, AuditSym ensures **absolute data privacy**. All data, AI processing, and evidence remain strictly within your local environment, making it ideal for highly regulated industries, air-gapped networks, and privacy-conscious organizations.

### Why AuditSym?

Cybersecurity frameworks are powerful, but in practice, they are often difficult to operationalize, fragmented, and repetitive to assess. AuditSym solves this by turning complexity into clarity:

| The Problem | The AuditSym Solution |
|-------------|-----------------------|
| Cloud GRC tools expose sensitive data | **100% Local-First** — your data never leaves your browser |
| Expensive SaaS subscriptions | **Open Source & Free** — no license fees, ever |
| Single-framework silos | **Multi-Framework** — NIST, ISO, CIS, COBIT in one place |
| Manual, spreadsheet-based audits | 🧠 **AI as a Co-Pilot**, Not an Autopilot . AuditSym uses AI to eliminate the blank-page syndrome. It suggests risk scores, drafts executive narratives, and extracts evidence from your PDFs via local RAG. However, the auditor always retains absolute control. Every AI suggestion requires explicit human validation before being recorded. If AI is unavailable, our deterministic scoring engine steps in seamlessly. Your audit, your criteria, your liability. |
| No prioritization of findings | **Priority Matrix** — Quick Wins first (Impact vs. Effort) |
| No historical tracking | **Evolution Tracking** — year-over-year security improvement |

---

## 📸 Interface Preview
### 📊 Multi-Framework Dashboard
### Multi-Framework Dashboard

![Multi-Framework Dashboard](screenshots/dashboardRiskSYM..jpg)

A visual overview of audit activity across frameworks, with summary metrics, compliance visibility, and risk-oriented monitoring.

---

### AI-Assisted Evidence Workflow

![AI Evidence Workflow](screenshots/AI%20Evidence2.jpg)

Designed to support a more efficient audit process with structured evidence handling and auditor-oriented documentation flow.

---

### Suggested Controls by Domain

![Suggested Controls](screenshots/Suggestcontrols3.jpg)

Framework-aware control suggestions help speed up audit preparation and make the workflow more practical.

---

### Framework Domain Selection

![Framework Domain Selection](screenshots/Suggestdomain6.jpg)

Controls can be explored from a domain perspective, making the tool easier to use for real audit sessions.

---

### Framework Progress Tracking

![Framework Progress](screenshots/frameworkprogreSYM.jpg)

Progress bars make it easier to see evaluation coverage across NIST, ISO, CIS, and COBIT at a glance.

---

### Control Grid Overview

![Control Grid](screenshots/gridControls5.jpg)

A more visual control map helps identify evaluated items and improves audit readability.

---

### Framework Control Workspace

![Framework Controls Workspace](screenshots/Frameworkcontrols3.jpg)

The main workspace is built around practical control handling: compliance, risk, notes, and evidence.

---

### Reporting View

![Reporting View](screenshots/SCREENSHOT1.jpg)

AuditNIST Pro is designed to support structured reporting and a cleaner audit output workflow.

---

###  Remediation Hub & Priority Matrix
![Priority Matrix](screenshots/HALLAZGOSyREMEDIACION.jpg)
*Automatically classifies findings into Quick Wins, Critical, Opportunities, and Strategic based on Impact vs. Effort.*

### 🤖 AI-Assisted Finding Detail
![Finding Detail](screenshots/historicalEvolutionSYM.jpg)
*Each finding includes AI-assisted remediation guidance and prioritization, evidence suggestions, and complexity/effort analysis.*

---

## ✨ Key Features

###  Audit Engine (`auditnist-local.html`)
- **Multi-Framework Support**: Evaluate controls against NIST CSF 2.0, ISO 27001, CIS Controls v8, and COBIT 2019 simultaneously.
- **AI Assessment**: Risk-weighted scoring with maturity model and AI-generated executive narrative.
- **Local RAG**: Semantic search and analysis of PDF policies and procedures (requires local Python server).
- **5 AI Providers**: Ollama (Local), OpenAI, Anthropic, Groq, OpenRouter.
- **Deterministic Fallback**: Works offline with a built-in scoring engine when AI is unavailable.

### 🛠️ Remediation Hub (`remediation-hub.html`)
- **Priority Matrix**: Automatic classification of findings (Quick Wins, Critical, Opportunities, Strategic).
- **Finding Lifecycle**: Open → Assigned → In Progress → Pending Validation → Closed.
- **Risk Acceptance Workflow**: Formal approval with approver, justification, and review date (ISO 27001 / SOX compliant).
- **AI Remediation Copilot (initial version)**: AI-generated recommendations and evidence suggestions per finding.
- **Historical Evolution Dashboard**: Year-over-year security posture tracking and continuous improvement.

###  Platform & Privacy
- **7 Languages**: ES, EN, FR, DE, PT, AR, ZH.
- **Local-First Design**: No backend required. All data persists in browser LocalStorage.
- **Offline Ready**: Fully functional without an internet connection.
- **Export/Import**: JSON bidirectional sync between Audit and Remediation modules, plus PDF report generation.

---

## 🏗️ Architecture & Tech Stack

AuditSym is evolving toward a modular, scalable architecture built around:
- **Audit Engine** & **Framework Adapters**
- **Evaluation Registry** & **Template Library**
- **Reporting Engine** & **AI Layer**

**Tech Stack:**
- **Frontend**: HTML5, CSS3 (Tailwind CSS / Custom), JavaScript (ES6+)
- **Visualization**: Chart.js
- **Reporting**: jsPDF, FileSaver.js
- **Storage**: Browser LocalStorage (Local-first)
- **AI Integration**: REST API calls to external providers / Local Ollama
- **RAG**: Optional local Python server (`rag/server.py`) for PDF analysis

---

## 🛣️ Roadmap

### ✅ Phase 1 — Foundation (Completed)
- [x] Multi-framework support (NIST, ISO, CIS, COBIT)
- [x] AI Assessment with 5 providers
- [x] Local RAG for PDF analysis
- [x] Remediation Hub with Priority Matrix
- [x] Risk Acceptance workflow
- [x] 7-language internationalization

### 🔵 Phase 2 —  Audit Lifecycle (In Progress)

✔ Initial Remediation Hub
✔ Historical Evolution
✔ Risk Acceptance Workflow

Next:
- [ ] Findings
- [ ] Management Response
- [ ] Closure

### 🟣 Phase 3 — Enterprise & Scale (Future)
- [ ] Collaborative auditing (multi-user sync)
- [ ] Jira / ServiceNow integrations
- [ ] Professional report templates
- [ ] AuditSym Cloud (optional hosted version)

---

## 🤝 How to Contribute

AuditSym welcomes contributors at all levels. Whether you want to improve the interface, refine the logic, or help shape the architecture, there is room to contribute.

### 🟢 Level 1 — Quick Contributions
Good starting tasks for UI/UX improvements:
- [ ] Improve UI spacing and control card layout
- [ ] Improve dashboard styling and chart readability
- [ ] Improve responsiveness and accessibility
- [ ] Improve dark mode consistency

### 🔵 Level 2 — Core Improvements
More technical contributions for the audit logic:
- [ ] Refactor Audit Engine and control data model
- [ ] Improve evaluation persistence and import/export logic
- [ ] Improve state management and performance with large audits

### 🟣 Level 3 — Advanced Ideas
Future-oriented contributions for the platform:
- [ ] Cross-framework mapping engine
- [ ] Advanced risk scoring engine
- [ ] AI audit assistant improvements

---

## 🚀 Running the Project

**Option 1: Direct Open**
Simply open `auditnist-local.html` or `remediation-hub.html` in your browser.

**Option 2: Local Server (Recommended)**

python -m http.server 8080
 Then visit http://localhost:8080
 
 
**Option 3: Local RAG Server (Optional)**
    123
    License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
See the LICENSE file for details.
What this means:
✅ Free to use, modify, and distribute.
✅ Can be used commercially.
️ Modifications must also be open source (AGPL).
⚠️ Network use requires sharing source code.
This license protects the open-source nature of AuditSym while allowing commercial consulting and support services.
⭐ Support the Project
If you find AuditSym useful: Give the repository a star ⭐
Open issues for improvements or bugs
Contribute new framework adapters or translations
Share your feedback and use cases
AuditSym is being built to make cybersecurity audits more structured, intelligent, and privacy-first.

We believe an audit should not end with a report — it should drive continuous improvement.

<div align="center">

<img src="screenshots/logo_AuditSYM.png" width="220" alt="AuditSym Logo">

**AuditSym**

*AI-Assisted Cybersecurity Audit & GRC Platform*

**Plan • Assess • Report • Remediate • Improve**



</div>
<div align="center">

⬆ Back to top
</div>
