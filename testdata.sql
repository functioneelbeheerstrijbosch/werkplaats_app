-- ─────────────────────────────────────────────────────────────────
-- TESTDATA — Werkplaats App
-- Voer uit in MySQL Workbench via: File → Open SQL Script
-- ─────────────────────────────────────────────────────────────────

SET FOREIGN_KEY_CHECKS = 0;

-- ── Monteurs ──────────────────────────────────────────────────────
-- id=1 (Jesper) bestaat al; alleen extra monteurs toevoegen
INSERT INTO monteurs (id, naam, initialen, email, actief, is_admin, auth_user_id,
  werkplaats_toegang, witgoed_toegang, is_onderdelenbeheerder) VALUES
(2, 'Marco Hendriks', 'MH', 'marco@strijbosch.nl', 1, 0, 2, 1, 0, 0),
(3, 'Lisa de Vries',  'LV', 'lisa@strijbosch.nl',  1, 0, 3, 1, 0, 0)
ON DUPLICATE KEY UPDATE naam = VALUES(naam);

-- Geef Jesper (id=1) alle benodigde toegangen
UPDATE monteurs SET
  werkplaats_toegang     = 1,
  witgoed_toegang        = 1,
  is_onderdelenbeheerder = 1
WHERE id = 1;

-- ── PM Oorzaakcodes ───────────────────────────────────────────────
INSERT INTO pmoorzaak (id, code, omschrijving) VALUES
(1, 'GBR', 'Gebruikersfout'),
(2, 'SLT', 'Slijtage'),
(3, 'DEF', 'Fabricagefout'),
(4, 'VLT', 'Vocht / vloeistof'),
(5, 'ELK', 'Elektrisch defect'),
(6, 'MEC', 'Mechanisch defect'),
(7, 'ONB', 'Onbekend')
ON DUPLICATE KEY UPDATE omschrijving = VALUES(omschrijving);

-- ── Postcodes ─────────────────────────────────────────────────────
INSERT INTO postcodes (id, postcode, straat, stad, lat, lng) VALUES
(1, '5388RG', 'Heescheweg',  'Nistelrode',         51.6934, 5.5521),
(2, '5211AA', 'Markt',       's-Hertogenbosch',    51.6978, 5.3037),
(3, '6811AA', 'Marktstraat', 'Arnhem',             51.9851, 5.8987),
(4, '1012AA', 'Damrak',      'Amsterdam',          52.3740, 4.8897),
(5, '3011AA', 'Coolsingel',  'Rotterdam',          51.9225, 4.4792)
ON DUPLICATE KEY UPDATE stad = VALUES(stad);

-- ── Onderdelen (reserveonderdelen) ────────────────────────────────
INSERT INTO onderdelen (id, artikelnr, naam, merk, prijs, voorraad) VALUES
(1, 'ART-001', 'Pomp wasmachine',    'Bosch',   45.00, 5),
(2, 'ART-002', 'Verwarmingselement', 'Siemens', 32.50, 8),
(3, 'ART-003', 'Deurslot',           'Miele',   18.75, 12),
(4, 'ART-004', 'Condensatorset',     'Philips', 12.00, 20),
(5, 'ART-005', 'Riem droger',        'AEG',      8.50, 15),
(6, 'ART-006', 'Printplaat',         'Bosch',   89.00,  3),
(7, 'ART-007', 'Temperatuursensor',  'Siemens', 14.25, 10),
(8, 'ART-008', 'Waterinlaatklep',    'Miele',   24.00,  6)
ON DUPLICATE KEY UPDATE naam = VALUES(naam);

-- ── Artikel voorraad ──────────────────────────────────────────────
INSERT INTO artikel_voorraad (id, artikelcode, apparaat, merk, model, aantal, min_aantal, locatie) VALUES
(1, 'ART-001', 'Wasmachine', 'Bosch',   'WAN28070NL',  5,  2, 'Rek A1'),
(2, 'ART-002', 'Wasmachine', 'Siemens', 'WM14T790NL',  8,  3, 'Rek A2'),
(3, 'ART-003', 'Wasmachine', 'Miele',   'W1 Classic',  12, 4, 'Rek B1'),
(4, 'ART-004', 'Droger',     'Philips', 'GC4900',      20, 5, 'Rek B2'),
(5, 'ART-005', 'Droger',     'AEG',     'T8DBE68SC',   15, 5, 'Rek C1'),
(6, 'ART-006', 'Vaatwasser', 'Bosch',   'SMV4HVX00N',  3,  1, 'Rek C2'),
(7, 'ART-007', 'Koelkast',   'Siemens', 'KS36VVIEP',   10, 3, 'Rek D1'),
(8, 'ART-008', 'Wasmachine', 'Miele',   'WDB030',      6,  2, 'Rek D2')
ON DUPLICATE KEY UPDATE artikelcode = VALUES(artikelcode);

-- ── Reparaties ────────────────────────────────────────────────────
-- status: '445'=open/claimbaar, '465'=in behandeling, '519'=afgerond
-- doorsluizenjn: 'J'=werkregel (verplicht om te verschijnen in de app)
INSERT INTO reparaties (id, opdrachtnr, opdrachtcode, opdrachtstatus, artikelcode, artikelomschrijving, merk, model, serienummer, klant_naam, klant_nummer, prioriteit, status, klacht, doorsluizenjn, monteur_id, aangemaakt_op) VALUES
(1, 'W2024-001', 'REP', 'open',            'WAS-001', 'Wasmachine',  'Bosch',   'WAN28070NL',  'SN123456', 'Jan Pietersen', 'K001', 'normaal', '445', 'Trilt erg tijdens het centrifugeren',            'J', NULL, NOW()),
(2, 'W2024-002', 'REP', 'open',            'WAS-002', 'Wasmachine',  'Miele',   'W1 Classic',  'SN234567', 'Marie Jansen',  'K002', 'spoed',   '445', 'Lekt water aan de onderkant',                    'J', NULL, NOW()),
(3, 'W2024-003', 'REP', 'in behandeling',  'DRO-001', 'Droger',      'AEG',     'T8DBE68SC',   'SN345678', 'Piet de Boer',  'K003', 'hoog',    '465', 'Droogt niet meer goed, kleren blijven vochtig',  'J', 1,    NOW()),
(4, 'W2024-004', 'REP', 'in behandeling',  'VAA-001', 'Vaatwasser',  'Bosch',   'SMV4HVX00N',  'SN456789', 'Anna Bakker',   'K004', 'normaal', '465', 'Reinigt niet goed, vlekken op glazen',           'J', 1,    NOW()),
(5, 'W2024-005', 'REP', 'afgerond',        'KOE-001', 'Koelkast',    'Siemens', 'KS36VVIEP',   'SN567890', 'Kees Visser',   'K005', 'laag',    '519', 'Koelt niet meer, loopt warm',                    'J', 1,    DATE_SUB(NOW(), INTERVAL 2 DAY)),
(6, 'W2024-006', 'REP', 'open',            'WAS-003', 'Wasmachine',  'Samsung', 'WW90T986ASH', 'SN678901', 'Truus Smit',    'K006', 'spoed',   '445', 'Deur gaat niet meer open na centrifugeren',      'J', NULL, NOW())
ON DUPLICATE KEY UPDATE status = VALUES(status), doorsluizenjn = VALUES(doorsluizenjn), monteur_id = VALUES(monteur_id);

-- ── Reparatie logs ────────────────────────────────────────────────
INSERT INTO reparatie_logs (id, reparatie_id, monteur_id, monteur_naam, actie, opdrachtnr, artikelcode, notitie, bestede_tijd_minuten, aangemaakt_op) VALUES
(1, 3, 1, 'Jesper van de Ven', 'start',             'W2024-003', 'DRO-001', 'Reparatie gestart',                     0,  NOW()),
(2, 3, 1, 'Jesper van de Ven', 'diagnose',          'W2024-003', 'DRO-001', 'Verwarmingselement defect gevonden',    20, NOW()),
(3, 3, 1, 'Jesper van de Ven', 'onderdeel_besteld', 'W2024-003', 'DRO-001', 'Verwarmingselement besteld (ART-002)',  5,  NOW()),
(4, 4, 1, 'Jesper van de Ven', 'start',             'W2024-004', 'VAA-001', 'Vaatwasser ingecheckt op werkplek',     0,  NOW()),
(5, 5, 1, 'Jesper van de Ven', 'start',             'W2024-005', 'KOE-001', 'Koelkast onderzocht',                   15, DATE_SUB(NOW(), INTERVAL 2 DAY)),
(6, 5, 1, 'Jesper van de Ven', 'afgerond',          'W2024-005', 'KOE-001', 'Condensator vervangen, werkt weer',    45, DATE_SUB(NOW(), INTERVAL 1 DAY))
ON DUPLICATE KEY UPDATE actie = VALUES(actie);

-- ── Tags ──────────────────────────────────────────────────────────
INSERT INTO tags (id, tagnummer, reparatie_id, artikelcode, locatie) VALUES
(1, 'TAG-001', 3, 'DRO-001', 'Stelling 1A'),
(2, 'TAG-002', 4, 'VAA-001', 'Stelling 1B'),
(3, 'TAG-003', 5, 'KOE-001', 'Stelling 2A'),
(4, 'TAG-004', 1, 'WAS-001', 'Stelling 2B'),
(5, 'TAG-005', 2, 'WAS-002', 'Stelling 3A')
ON DUPLICATE KEY UPDATE tagnummer = VALUES(tagnummer);

-- ── Tagnr scans ───────────────────────────────────────────────────
INSERT INTO tagnr_scans (id, reparatie_log_id, reparatie_id, opdrachtnr, regelnummer, artikelcode, tagnr, monteur_id) VALUES
(1, 1, 3, 'W2024-003', 1, 'DRO-001', 'TAG-001', 1),
(2, 4, 4, 'W2024-004', 1, 'VAA-001', 'TAG-002', 1),
(3, 5, 5, 'W2024-005', 1, 'KOE-001', 'TAG-003', 1)
ON DUPLICATE KEY UPDATE tagnr = VALUES(tagnr);

-- ── Witgoed apparaten ─────────────────────────────────────────────
INSERT INTO witgoed_apparaten (id, reparatie_id, opdrachtnr, regelnummer, artikelcode, artikelomschrijving, productgroep, tagnr, werkplek, nen_optisch, nen_technisch, diagnose, monteur_id, status) VALUES
(1, 3, 'W2024-003', 1, 'DRO-001', 'Droger AEG T8DBE68SC',      'Drogers',      'TAG-001', 'WP-A', 8, 7, 'Verwarmingselement defect', 1, 'actief'),
(2, 4, 'W2024-004', 1, 'VAA-001', 'Vaatwasser Bosch SMV4HVX',  'Vaatwassers',  'TAG-002', 'WP-B', 9, 8, 'Sproeiarm verstopt',        1, 'actief'),
(3, 5, 'W2024-005', 1, 'KOE-001', 'Koelkast Siemens KS36VVIEP','Koelkasten',   'TAG-003', 'WP-C', 7, 6, 'Condensator defect',        1, 'afgerond')
ON DUPLICATE KEY UPDATE opdrachtnr = VALUES(opdrachtnr);

-- ── Vragensets ────────────────────────────────────────────────────
INSERT INTO vragensets (id, titel, productgroep, actief) VALUES
(1, 'Afronding wasmachine', 'Wasmachines', 1),
(2, 'Afronding droger',     'Drogers',     1),
(3, 'Afronding vaatwasser', 'Vaatwassers', 1)
ON DUPLICATE KEY UPDATE titel = VALUES(titel);

-- ── Vragen ────────────────────────────────────────────────────────
INSERT INTO vragen (id, vragenset_id, volgorde, vraag_tekst, type, verplicht) VALUES
(1, 1, 1, 'Is de machine goed gereinigd?',        'meerkeuze', 1),
(2, 1, 2, 'Wat is de eindcontrole uitkomst?',     'open',      1),
(3, 1, 3, 'Geef een kwaliteitsscore (1-10)',      'open',      1),
(4, 2, 1, 'Is het verwarmingselement getest?',    'meerkeuze', 1),
(5, 2, 2, 'Droogtijd na reparatie (minuten)',     'open',      0),
(6, 3, 1, 'Zijn alle sproeiarms gecontroleerd?',  'meerkeuze', 1),
(7, 3, 2, 'Temperatuurcontrole uitgevoerd?',      'meerkeuze', 1)
ON DUPLICATE KEY UPDATE vraag_tekst = VALUES(vraag_tekst);

-- ── Antwoordopties ────────────────────────────────────────────────
INSERT INTO antwoordopties (id, vraag_id, optie_tekst, waarde, volgorde) VALUES
(1, 1, 'Ja',    1, 1),
(2, 1, 'Nee',   0, 2),
(3, 1, 'N.v.t', 0, 3),
(4, 4, 'Ja',    1, 1),
(5, 4, 'Nee',   0, 2),
(6, 6, 'Ja',    1, 1),
(7, 6, 'Nee',   0, 2),
(8, 7, 'Ja',    1, 1),
(9, 7, 'Nee',   0, 2)
ON DUPLICATE KEY UPDATE optie_tekst = VALUES(optie_tekst);

-- ── Reparatie antwoorden (voor afgeronde reparatie #5) ────────────
INSERT INTO reparatie_antwoorden (id, reparatie_id, vraag_id, antwoord) VALUES
(1, 5, 1, 'Ja'),
(2, 5, 2, 'Werkt prima na vervanging condensator'),
(3, 5, 3, '9')
ON DUPLICATE KEY UPDATE antwoord = VALUES(antwoord);

-- ── Gebruiker instellingen ────────────────────────────────────────
INSERT INTO gebruiker_instellingen (id, monteur_id, auth_user_id, taal_voorkeur) VALUES
(1, 1, 1, 'nl')
ON DUPLICATE KEY UPDATE taal_voorkeur = VALUES(taal_voorkeur);

-- ── Onderdelen kleuren ────────────────────────────────────────────
INSERT INTO onderdelen_kleuren (id, opdrachtnr, kleur) VALUES
(1, 'W2024-003', 'oranje'),
(2, 'W2024-004', 'groen')
ON DUPLICATE KEY UPDATE kleur = VALUES(kleur);

-- ── Vertalingen ───────────────────────────────────────────────────
INSERT INTO vertalingen (id, origineel, taal, vertaling) VALUES
(1, 'open',           'en', 'open'),
(2, 'in_behandeling', 'en', 'in progress'),
(3, 'afgerond',       'en', 'completed'),
(4, 'spoed',          'en', 'urgent'),
(5, 'hoog',           'en', 'high'),
(6, 'normaal',        'en', 'normal'),
(7, 'laag',           'en', 'low')
ON DUPLICATE KEY UPDATE vertaling = VALUES(vertaling);

SET FOREIGN_KEY_CHECKS = 1;

SELECT 'Testdata succesvol ingevoerd!' AS resultaat;
