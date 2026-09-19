# Data

## scf-controls.json

Main control dataset used by AuditSym.

- Source: Secure Controls Framework (SCF)
- Version: 2025.4
- Purpose: normalized control library with cross-framework mapping
- Used for: control suggestions, template library, audit workflows, and framework mapping
- Canonical language: English

## i18n/

Localization overlays for SCF control content.

Each file contains translated `name` and `question` fields keyed by the original SCF control ID. The canonical `scf-controls.json` dataset is never modified.

Current overlays:

- `controls.es.json` — Spanish localization for the 438 SCF controls

Fallback behavior:

- English is the canonical source
- If a localization entry is missing or cannot be loaded, AuditSym falls back to the English content from `scf-controls.json`

Planned structure:

```text
i18n/
├── controls.es.json
├── controls.fr.json
├── controls.de.json
├── controls.pt.json
├── controls.ar.json
└── controls.zh.json