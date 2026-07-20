# Chat Support Quality Review Panel — Mostanad

---

## Chist va baraye che kari hast?

In panel yek abzar daakheli baraye team sarparast-ha va manager-hast ke be anha komak mikone:

- Chat-haye LiveChat ro az tarigh API be sorat khودkar download va zakhire kone
- Har chat ro ba komak هوش مصنوعی (Claude AI) arzyabi va nomre-dahi kone
- Amalkard har agent ra dar toole mah besorat khودkar hisab kone va gozaresh bede
- Nokaat zoaf va ghovat har agent ra moshakhas kone
- Data-haye KB (knowledge base), protocol-ha, campaign-ha va macro-ha ra update kone

Panel be sorat localhost roo server shoma ejra mishe va dastras oon faghat baraye afrade moazzan hast.

---

## Amkanat va Menue-ha

### 1. Dashboard

**Chizi ke neshoon mide:**
- Tedade kol chat-ha
- Tedade review-haye anjam shode
- Percentage review
- Miyangine nomre (score) team
- Nemodar (bar chart) nomreh-haye mahane be tafkik agent

**Karbord:**  
Manager ya sarparast yek negah kollie be vaziate kol team dare. Mishe mah-be-mah moghayese kard.

---

### 2. Chat Review

**Chizi ke neshoon mide:**
- Liste chat-ha be tafkik tarikh va agent
- Nomre hare chat (agar review shode bashe)
- Botone "Review All with AI" ke hame chat-ha ro dar yek daghighe review mikone

**Joziat review:**  
Baraye har chat, AI mored-haye zir ra arzyabi mikone:

| Mored | Tozih |
|---|---|
| Greet & Goodbye | Salam va khodeafezi monaaseb |
| Empathy | Tavasojh be hasasiate mashteri |
| Protocol | Rad-e-amale dorost tarafsaz-haye daakheli |
| Solution | Araye eke hal dorost |
| Campaign | Estefade az campaign-e monaseb |
| Macro | Estefade sahih az macro-ha |
| Tags | Tag-gozari dorost |
| Language | Zaban motabesgh ba mashteri |
| Clarity | Wazeh boodane peyam-ha |
| Overall | Nomre kollie |

Har mored nomre 0 ta 5 mire va AI yek comment ham mide ke agent chetoor metavane behtar beshe.

---

### 3. Reports (Gozaresh Mahane)

**Chizi ke neshoon mide:**
- Gozaresh mahane har agent
- Nomreh-haye miyangine har mored
- Tedad chat-haye review shode
- Tahlil AI (kholase moshkelat va pishnhad-haye behbod)

**Karbord:**  
Sarparast mishe baraye jalasat mahane ya feedback gozaresh PDF-style print kone ya be agent email bede.

---

### 4. Employees (Admin Only)

**Chizi ke neshoon mide va dare:**
- Liste karkonan
- Mapping agent LiveChat be karkonan
- Zaman-bandi shift (oruz va saate kaari)
- Goroh-bandi (maslan takhassose zaban ya bakhsh)
- Zaban-haye morede estefade har agent

**Karbord:**  
Vaghti system mekhahe chat-e yek agent ra arzyabi kone, azin etelaat estefade mikone ta bedane chand chat baye review shave va dar che bazeye zamanie.

---

### 5. Config (Admin Only)

**Chizi ke neshoon mide va dare:**
- Adrese API-haye KB (Knowledge Base, Protocol, Campaigns, Macros, Tags)
- Dokme Refresh All — hame manabe ro update mikone
- Sync LiveChat Agents — liste agent-haye LiveChat ro az API mige
- Fix Dashboard Data — data-haye dashboard ra dorst mikone

**Karbord:**  
Vaghti KB ya protocol jadid mikhay, inja update mikoni. System az Google Docs va Google Sheets mikhone.

---

## Niazmandiha (Requirements)

### 1. LiveChat

- Account faale LiveChat lazeme
- Personal Access Token (PAT) ba dastrasee به chat-ha va report-ha
- API version: v3.6

### 2. Claude AI (Anthropic API)

- Account dar anthropic.com lazeme
- API Key baraye estefade az model claude-sonnet-4-6
- Credit (har mah charge mishavad — tozih zir)

### 3. Server

- Node.js v18 ya bala
- PostgreSQL (ekhtiayari, baraye zakhiresazi data)
- Hameye chatide-ha roo yek makhin ya server ejra mishavad (mishe localhost ya VPS)

---

## Mohasebeye Hazine Claude API

### Model Morede Estefade

`claude-sonnet-4-6` — model standarde mostaghim baraye arzyabi

| Nogh | Gheymat |
|---|---|
| Input (chataye ervadi + KB + system prompt) | $3.00 per 1 million token |
| Output (nomre-ha + feedback AI) | $15.00 per 1 million token |

---

### Tokene Morede Estefade har Review

Baraye har chat, system do ghesmeto API mifreste:

1. **System prompt + KB + chat transcript** → input
2. **JSON ba nomre-ha va feedback** → output

| Nogh | Token-haye taghribi |
|---|---|
| Input har review | ~8,000 token (taghribi) |
| Output har review | ~500 token |

---

### Senaario: 5,000 Chat dar Mah

- 5,000 chat vojud dare
- 1,000 ta az onha ba 2 ta agent anjam shode = 2,000 review
- Baghie 4,000 chat ba 1 agent = 4,000 review
- **Kol review-ha: 6,000**

---

### Mohasebeye Hazine

#### Review-haye AI (6,000 review)

| Nogh | Mohasebeye | Hazine |
|---|---|---|
| Input | 6,000 × 8,000 token = 48,000,000 token ÷ 1,000,000 × $3.00 | **$144** |
| Output | 6,000 × 500 token = 3,000,000 token ÷ 1,000,000 × $15.00 | **$45** |
| **Jame Review** | | **~$189** |

#### Gozaresh-haye Mahane (yakbar dar mah)

Baraye har employee yek tahlile AI roye gozareshe mahane anjam mishe. Agar 15 nafar employee bashan:

| Nogh | Hazine taghribi |
|---|---|
| 15 gozaresh mahane | ~$1 - $2 |

---

### Kholaseye Hazine

| Mored | Hazine |
|---|---|
| 6,000 AI review (5,000 chat, 1,000 ba 2 agent) | ~$189 |
| 15 gozaresh mahane AI | ~$1 - $2 |
| **Kole Mahane** | **~$190 - $200** |

> **Tavajoh:** In adad taghribie. Dar soorate طولانی بودن chat-ha (bish az 3,000 kaleme), hazine kami baala tar mishe va dar soorat chataye kootah tar payin tar. Mohasebeye conservative-tar (ba 10,000 token input) hazina ra be haghe ~$250 dar mah miresone.

---

### Baraye Moghayese

Agar az model-haye arzan-tar estefade beshe:

| Model | Hazine taghribi baraye 6,000 review |
|---|---|
| Claude Sonnet 4.6 (felan estefade mishe) | ~$190 |
| Claude Haiku 4.5 (arzan-tar, keyfeeyate kamtar) | ~$30 - $40 |

Haiku baraye review-haye saadeh (salam/khodeafezi, tag) manaasebe, amma baraye tahlile kamle protocol va empathy keyfeeyate paeean-tari dare.

---

## Kholase Baraye Tasmimgiri

| Soal | Javab |
|---|---|
| Sistema che kari anjam mide? | Chat-haye LiveChat ra az AI arzyabi mikone va gozareshe karkonan ro khoodkar mirisazad |
| Che softwari niyaz dareem? | Node.js, LiveChat API, Anthropic API key |
| Hazine mahane baraye 5,000 chat cheghadr hast? | Taghribi **$190 - $250** |
| Aya mishe system ro khaamosh kard ta hazine nadashe bashim? | Bale, review-ha faghat vaghti dastiaan ra mizanid anjam mishavad |
| Aya data-ha secure hastand? | Bale, hame data-ha roo server-e khode shoma zakhire mishavad |

---

*Vesion: 1.0 — Tarikh: 2026-07-13*
