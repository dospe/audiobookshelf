# E-knihy: víc knih v jednom adresáři

Audiobookshelf má datový model odvozený z audioknih: **jedna kniha = jeden adresář**.
U e-knih to nefunguje — v jednom adresáři bývá víc knih od jednoho autora nebo celá
série a ABS z nich udělal jednu položku, kde byl jeden soubor „hlavní“ a ostatní jen
doplňkové formáty.

Tento fork přidává nastavení knihovny **„Rozdělit složky s více e-knihami na samostatné
knihy“** (`splitEbooksByFile`). Je **zapnuté ve výchozím stavu** i pro knihovny založené
před touto změnou; vypnout se dá v nastavení knihovny.

## Jak scanner rozhoduje

Adresář se rozdělí na samostatné knihy, když **přímo v něm není žádný audio soubor** a zároveň

- obsahuje **dvě a více e-knih s různým názvem souboru**, nebo
- obsahuje **jednu e-knihu a další e-knihy v podadresářích** (adresář autora s volnou knihou
  vedle složky série je „police“, ne kniha).

Co drží pohromadě jako jednu knihu: soubory se **stejným názvem bez přípony** ve stejném
adresáři — `Kniha.epub` + `Kniha.pdf` + `Kniha.mobi` (epub je hlavní, ostatní doplňkové
formáty) a k nim `Kniha.opf`, `Kniha.jpg`, `Kniha.nfo`. Soubor, který se do žádné knihy
netrefí (společný `cover.jpg`, `desc.txt`), se k žádné nepřipojí — jinak by se stejný popis
přilepil ke všem knihám.

Co se **nemění**:

- adresář s audio soubory zůstává jednou audioknihou, e-kniha vedle ní je doplňkový formát,
- adresář s jedinou knihou (i s více formáty a obálkou) zůstává jednou položkou,
- e-knihy přímo v kořeni složky knihovny jsou dál samostatné položky bez autora,
- při zapnutém **Pouze audioknihy** se e-knihy ignorují jako dosud.

## Metadata rozdělených knih

Cesta se parsuje stejně jako u adresářů — `/autor/série/titul/` — jen místo složky knihy
je název souboru:

| Cesta | Autor | Série | Titul |
| --- | --- | --- | --- |
| `Karel Čapek/Válka s mloky.epub` | Karel Čapek | – | Válka s mloky |
| `Karel Čapek/Trilogie/2 - Povětroň.epub` | Karel Čapek | Trilogie, díl 2 | Povětroň |

Pozor: u knihy `Autor/Název knihy/Druhá kniha.epub` se prostřední složka bere jako série,
přesně jako u adresářů. Doporučená struktura pro e-knihy je proto plochá: `Autor/Název.epub`
nebo `Autor/Název/Název.epub`.

Metadata z `.opf` vedle souboru i z OPF uvnitř epubu mají vyšší prioritu než názvy souborů
(pořadí zdrojů v nastavení scanneru knihovny), takže `calibre:series` z Calibre exportu
funguje. Obálka se bere z obrázku se stejným názvem, jinak z epubu. Protože položka je
soubor a ne adresář, `metadata.json` a `cover.jpg` se ukládají do `/metadata/items/<id>/`,
ne vedle knihy — dvě knihy v jednom adresáři by si je přepisovaly.

## Co čekat po zapnutí na existující knihovně

Adresář, který byl dosud jednou položkou, se po dalším scanu rozpadne na samostatné
knihy. Jedna z nich převezme původní položku (včetně rozečtenosti), ostatní vzniknou jako
nové. Když naopak nastavení vypneš, knihy se zase sloučí a přebývající položky zůstanou
označené jako **chybějící** — uklidí je „Odebrat položky s problémy“ v nastavení knihovny.

Watcher zvládá přidání i smazání knihy v rozděleném adresáři za běhu. Pokud po smazání
v adresáři zůstane jediná kniha, adresář se zase stane jednou položkou (převezme ji ta
zbývající kniha).

## Calibre: kdy ano a kdy ne

S tímto nastavením **není nutné knihovnu přeorganizovat přes Calibre**, aby ABS viděl
všechny knihy. To má dvě zásadní výhody:

- žádné kopírování souborů → položky si drží identitu (párování podle cesty a inodu),
  rozečtenost, záložky a kolekce zůstávají,
- na rclone/Google Drive mountu se nic znovu nenahrává.

Calibre dává smysl jako **volitelný krok pro doplnění metadat** (`calibredb add -r` →
oprava metadat → `calibredb export`). Pak počítej s tím, že:

1. export je **kopie** — nové inody, nové položky, ztráta rozečtenosti, záložek, kolekcí
   a statistik (osiřelou rozečtenost server při startu maže),
2. `calibredb export` bez `--dont-asciiize` zahodí diakritiku v názvech,
3. `calibredb add` bez `--duplicates` tiše přeskočí knihy se stejným názvem a autorem,
4. `doc`, `docx`, `rtf`, `pdb` Calibre nepřečte dobře a metadata hádá z názvu souboru,
5. doprovodné soubory (`.nfo`, `desc.txt`, další obrázky) export nepřenese.

Pro šablonu exportu použij `{authors}/{title}/{title}` (ne `{author_sort}`, i když ho parser
zvládne) a `--dont-asciiize`. Výstup `Autor/Název/Název.epub` + `metadata.opf` + `cover.jpg`
ABS načte správně.

Kde Calibre spustit: jednorázově v kontejneru na serveru, kde knihovna leží, ne jako
trvalou službu ve stacku a ne přetahováním knihovny na desktop a zpět:

```bash
docker run --rm -v /opt/audio/audiobooks:/knihy:ro -v /tmp/calibre:/lib \
  linuxserver/calibre calibredb add -r /knihy --library-path /lib --duplicates
```
