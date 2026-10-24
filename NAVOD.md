# Sedm moří – online verze pro kohokoli

Tahle složka je celá hra i s malým serverem. Server zobrazí hru v prohlížeči a přeposílá mezi hráči polohy lodí, zdraví a salvy. Kdo otevře adresu tvého serveru, hraje se všemi ostatními na jednom moři.

## Co je ve složce

| Soubor | K čemu je |
|---|---|
| `server.js` | herní server (Node.js) |
| `package.json` | popis projektu pro hosting (`npm install`, `npm start`) |
| `public/` | samotná hra: stránka, mapa, lodě, budovy |
| `public/progress.json` | ceny lodí, třídy a odměny – tady si můžeš upravit, jak rychle hráči postupují |
| `public/quests.json` | 50 úkolů s odměnami – texty, cíle i výši odměn si můžeš upravit |
| `data/accounts.json` | účty hráčů (vytvoří se sám po první registraci) |

## Vyzkoušení na vlastním počítači

1. Nainstaluj si [Node.js](https://nodejs.org) (verze 18 nebo novější).
2. Ve složce spusť v příkazovém řádku:
   ```
   npm install
   npm start
   ```
3. Otevři v prohlížeči `http://localhost:8080`.
4. Kamarádi ve stejné Wi-Fi se připojí přes adresu tvého počítače, například `http://192.168.1.20:8080`.

## Zveřejnění na internetu (Render)

Postup je ukázaný na službě Render, která umí Node.js i WebSockety a má bezplatný tarif. Podmínky tarifů se mění – před spuštěním si je ověř na render.com.

### 1. Nahraj hru na GitHub
1. Založ si účet na [github.com](https://github.com) a vpravo nahoře zvol **+ → New repository**.
2. Název třeba `sedm-mori`, viditelnost **Private** (nebo Public), nic dalšího nezaškrtávej a klikni na **Create repository**.
3. Na stránce prázdného repozitáře klikni na odkaz **uploading an existing file**.
4. **Nenahrávej soubor ZIP** – GitHub v prohlížeči přijme jen soubory do 25 MB a ZIP by stejně nerozbalil. Hra je proto rozdělená do tří menších ZIPů (`sedm-mori-1-zaklad.zip`, `sedm-mori-2-lode-a.zip`, `sedm-mori-3-lode-b.zip`). Každý rozbal a nahraj zvlášť, vždy stejně:
   - otevři rozbalenou složku, označ všechno uvnitř (Ctrl+A) a přetáhni to do okna GitHubu,
   - počkej, až se všechny soubory nahrají, a klikni na **Commit changes**,
   - pro další díl zvol v repozitáři **Add file → Upload files** a postup zopakuj.
   Díly 2 a 3 obsahují složku `public` jen se sprity lodí – GitHub je sám přidá do už nahrané složky `public/ships`.
5. Zkontroluj, že v kořeni repozitáře je přímo `server.js`, `package.json` a složka `public` (ne další složka navíc) a že `public/ships` obsahuje 36 souborů.

### 2. Vytvoř službu na Renderu
1. Založ si účet na [render.com](https://render.com) (nejjednodušší je přihlášení přes GitHub).
2. Zvol **New → Web Service** a u GitHubu povol Renderu přístup k repozitáři `sedm-mori`; pak ho vyber.
3. Vyplň:
   - **Name:** `sedm-mori` (z toho vznikne adresa `https://sedm-mori.onrender.com`)
   - **Region:** Frankfurt (EU Central) – nejblíž českým hráčům
   - **Branch:** `main`
   - **Runtime / Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free (na vyzkoušení) nebo placený (pro trvalý provoz, viz níže)
4. Klikni na **Deploy Web Service**. V záložce **Logs** se po minutě či dvou objeví `Sedm moří běží na portu …` – hra je venku.
5. Otevři adresu z horní části stránky služby a zkus se zaregistrovat. Adresu pak rozešli hráčům.

### 3. Trvalé uložení účtů (důležité)
Na bezplatném tarifu se soubory serveru mažou při každém restartu, novém nasazení i uspání – **s nimi zmizí i účty a zlaťáky hráčů**. Bezplatný tarif je proto jen na vyzkoušení. Pro skutečný provoz:
1. V nastavení služby přepni **Instance Type** na nejlevnější placený.
2. V záložce **Disks** přidej disk: **Mount Path** `/var/data`, velikost 1 GB stačí.
3. V záložce **Environment** přidej proměnnou `DATA_DIR` s hodnotou `/var/data` a ulož (služba se sama restartuje).
Od té doby se účty ukládají do `/var/data/accounts.json` a přežijí restarty i nové verze hry.

### 4. Nahrání nové verze hry
1. V repozitáři na GitHubu zvol **Add file → Upload files** a přetáhni změněné soubory (nebo znovu celý obsah ZIPu – stejnojmenné soubory se přepíšou).
2. **Commit changes.** Render si změnu všimne a za pár minut nasadí novou verzi sám (Auto-Deploy). Ručně jde nasadit přes **Manual Deploy → Deploy latest commit**.
3. Při nasazení se připojení hráčů na chvíli přeruší, hra se sama znovu připojí. Účty na disku zůstanou.

### 5. Užitečné
- **Uspávání zdarma:** bezplatná služba po 15 minutách bez hráčů usne a první návštěvník pak čeká asi minutu. Placená služba neusíná.
- **Přidání zlaťáků:** v **Environment** nastav `GRANT_GOLD` na `Jméno kapitána:5000` (více účtů oddělit čárkou). Každá hodnota se připíše jen jednou.
- **Vlastní doména:** v **Settings → Custom Domains** přidej doménu a u registrátora nastav záznam podle návodu Renderu.
- **Když něco nefunguje:** podívej se do **Logs**. Nejčastější chyby: `server.js` není v kořeni repozitáře, chybí složka `public`, nebo je špatně Start Command.

Podobně to funguje na Railway nebo Fly.io. Na vlastním serveru (VPS) stačí `npm install` a `npm start`; pokud před server dáš nginx, musí přeposílat WebSockety na cestě `/mp`.

## Účty a postup hráčů

- Při spuštění se hráč přihlásí nebo založí účet (jméno kapitána a heslo). Může hrát i jako host, jeho postup se pak ukládá jen v jeho prohlížeči.
- Každý nový kapitán začíná se Šalupou a 2 000 zlaťáky (`start` a `startGold` v `progress.json`). Další lodě – Brigantinu, Velkou brigantinu, Fregatu, Velkou fregatu, Řadovou loď, Trnovou růži a Zefyr – si kupuje v loděnici v přístavu za ceny v `price`.
- V kovárně si každou loď může vylepšit (8 druhů vylepšení, až 7 úrovní podle velikosti lodi – `upgCap`); ceny určuje `upgrades` v `progress.json`.
- Zlaťáky, vlastněné lodě a vybraná loď se ukládají na serveru do `data/accounts.json`. Odměny za potopené lodě a nestvůry počítá server sám a omezuje, jak často je lze získat. Za potopení jiného hráče dostane zlaťáky jen přihlášený hráč, kterého potopený označil.
- Server hlídá, aby hráč na moři vystupoval pod svým jménem a jen v lodi, kterou vlastní.
- Hesla se ukládají jen jako zašifrovaný otisk (scrypt), nikdy v čitelné podobě.

**Důležité – trvalé uložení účtů:** na mnoha bezplatných hostinzích (i na bezplatném tarifu Renderu) se soubory serveru při restartu nebo novém nasazení smažou a s nimi i účty. Pro skutečný provoz potřebuješ trvalé úložiště:
- na Renderu placený tarif s **Disk** připojeným třeba do `/var/data` a proměnnou `DATA_DIR=/var/data`,
- na vlastním serveru (VPS) se nic nemaže, stačí složku `data` zálohovat.

## Úkoly

Hra má 50 úkolů v pěti kapitolách (Začátky na moři, Obchodní cesty, Pirátské vody, Nestvůry hlubin, Legenda sedmi moří). Další kapitola se otevře po splnění 7 úkolů té předchozí. Úkoly hráč najde pod tlačítkem 📜 Úkoly, klávesou **Q** nebo v přístavu v taverně. Dva nejbližší cíle se ukazují vlevo nahoře.

- U přihlášených hráčů se splněné úkoly i statistiky (uplutá vzdálenost, potopené lodě, navštívené přístavy…) ukládají na serveru. Každý úkol vyplatí odměnu jen jednou.
- Úkoly na zlaťáky a třídu lodi ověřuje server sám, ostatní hlásí hra.
- V `public/quests.json` můžeš měnit názvy, popisy, cíle (`c`) a odměny (`r`). Číslo `id` už zveřejněného úkolu neměň, jinak by ho hráči mohli splnit podruhé.

## Nastavení

| Proměnná prostředí | Výchozí | Význam |
|---|---|---|
| `PORT` | 8080 | port serveru (hostingy ho nastavují samy) |
| `MAX_PLAYERS` | 64 | nejvíc hráčů najednou |
| `DATA_DIR` | `./data` | složka, kam se ukládají účty |

## Jak hra online funguje

- Jméno kapitána z účtu se ukáže nad lodí. Hosté mají před jménem „Host“.
- Ostatní hráče vidíš s modrou jmenovkou a na minimapě jako modré tečky. Můžeš na ně střílet, u přístavů je bezpečná zóna.
- Za potopení hráče dostaneš zlaťáky podle velikosti jeho lodi.
- Obchodníci, piráti a nestvůry jsou u každého hráče vlastní.

## Na co pamatovat

Zlaťáky a lodě hlídá server, ale samotné souboje se pořád vyhodnocují v prohlížečích hráčů (server jen omezuje, jak často lze odměnu získat). Zručný podvodník by tak mohl získávat zlaťáky rychleji, než by měl. Kdyby se hra hodně rozrostla, dá se simulace soubojů přesunout celá na server.

Pozice lodí na moři se neukládají – po restartu serveru hráči vyplouvají z přístavu, zlaťáky a lodě jim zůstanou.
