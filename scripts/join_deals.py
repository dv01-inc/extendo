"""
IGNORE THIS, it was used to bootstrap the first deal-map.json, should not be used further
Join Citi's (Issuer, Series) list with SecOps's deal names ("SHELF SERIES").

SecOps names deals by a shelf code (JPMMT, NRZT, ...) while Citi uses the full issuer
name, so names alone don't line up. Instead, each shelf is assigned to the Citi issuer
it shares the most series with, with name similarity breaking ties. Deals are then
matched on (issuer, series).

Usage: python3 scripts/join_deals.py [citi_map.csv] [secops_deals.csv] [out.csv]
"""

import csv
import re
import sys
from collections import defaultdict

STOPWORDS = {'and', 'of', 'the', 'inc', 'corp', 'na', 'co'}
# Series in Citi sometimes carry the shelf code too: "EFMT 2021-2", "CAS 2021-R02".
EMBEDDED_SHELF = re.compile(r'^([A-Za-z][A-Za-z ]*?)\s+(\d{4}-\S+)$')


def norm(s):
    # Uppercase, collapse whitespace, and drop leading zeros in numbers after the year
    # ("2026-01" -> "2026-1", "R02" -> "R2").
    s = re.sub(r'\s+', ' ', s).strip().upper()
    return re.sub(r'(?<=[^\d\s])0+(?=\d)', '', s)


def split_deal(deal):
    """'SCLMT III 2023-1' -> ('SCLMT III', '2023-1')."""
    shelf, _, series = norm(deal).rpartition(' ')
    return shelf, series


def name_score(shelf, issuer):
    """0..1: how plausibly `shelf` abbreviates `issuer`."""
    shelf = re.sub(r'[^a-z]', '', shelf.lower())
    words = [w for w in re.findall(r'[a-z]+', issuer.lower()) if w not in STOPWORDS]
    letters = ''.join(words)
    if not shelf or not letters:
        return 0.0
    if letters.startswith(shelf) or words[0].startswith(shelf):
        return 1.0
    acronym = ''.join(w[0] for w in words)
    if acronym.startswith(shelf) or shelf.startswith(acronym):
        return 0.95
    # Fraction of the shelf code found, in order, in the issuer's letters (longest common
    # subsequence; must share the first letter). Capped below prefix/acronym matches.
    if shelf[0] != letters[0]:
        return 0.0
    lcs = [0] * (len(letters) + 1)
    for ch in shelf:
        prev = 0
        for j, lc in enumerate(letters, 1):
            prev, lcs[j] = lcs[j], prev + 1 if ch == lc else max(lcs[j], lcs[j - 1])
    return 0.8 * lcs[-1] / len(shelf)


def main(citi_path='citi_map.csv', secops_path='secops_deals.csv', out_path='citi_and_secops_deals.csv'):
    with open(citi_path, encoding='utf-8-sig', newline='') as f:
        citi_rows = list(csv.DictReader(f))
    with open(secops_path, encoding='utf-8-sig', newline='') as f:
        secops_deals = [r['SECOPS_DEAL'].strip() for r in csv.DictReader(f) if r['SECOPS_DEAL'].strip()]

    # Index Citi by (issuer, series), splitting out any shelf embedded in the series.
    citi_index = {}  # (issuer, series) -> row index
    citi_embedded = {}  # full "SHELF SERIES" -> row index
    citi_series_by_issuer = defaultdict(set)
    for idx, row in enumerate(citi_rows):
        series = norm(row['Series'])
        m = EMBEDDED_SHELF.match(series)
        if m:
            citi_embedded[series] = idx
            series = m.group(2)
        citi_index[(row['Issuer'], series)] = idx
        citi_series_by_issuer[row['Issuer']].add(series)

    secops_series_by_shelf = defaultdict(set)
    for deal in secops_deals:
        shelf, series = split_deal(deal)
        secops_series_by_shelf[shelf].add(series)

    # Assign each shelf to the issuer it shares the most series with. The name has to be a
    # plausible abbreviation, and the overlap substantial unless the name fits strongly.
    shelf_issuer = {}
    for shelf, secops_series in secops_series_by_shelf.items():
        best = None
        for issuer, citi_series in citi_series_by_issuer.items():
            overlap = len(secops_series & citi_series)
            ns = name_score(shelf, issuer)
            if not overlap or ns < 0.5 or (overlap / len(secops_series) < 0.5 and ns < 0.9):
                continue
            score = overlap / len(secops_series) + ns
            if best is None or score > best[0]:
                best = (score, issuer, overlap, ns)
        if best:
            shelf_issuer[shelf] = best

    # Collect every candidate pairing, then give each Citi row its strongest candidate so
    # a weak match (JPMST 2024-1) can't claim a row ahead of the right deal (JPMMT 2024-1).
    # A deal may serve several rows: Citi lists some deals under two issuer names.
    candidates = []  # (priority, -name score, deal, Citi row index, method)
    for deal in secops_deals:
        shelf, series = split_deal(deal)
        if norm(deal) in citi_embedded:
            candidates.append((0, -1.0, deal, citi_embedded[norm(deal)], 'exact'))
        if shelf in shelf_issuer and (shelf_issuer[shelf][1], series) in citi_index:
            ns = shelf_issuer[shelf][3]
            candidates.append((1, -ns, deal, citi_index[(shelf_issuer[shelf][1], series)], 'shelf map'))
        # Same series under another issuer whose name fits the shelf (e.g. CSMC vs CSMCM Trust).
        for (issuer, s), i in citi_index.items():
            ns = name_score(shelf, issuer)
            if s == series and ns >= 0.9:
                candidates.append((2, -ns, deal, i, 'series + name'))

    matches = {}  # Citi row index -> (deal, method)
    for _, _, deal, idx, method in sorted(candidates, key=lambda c: c[:2]):
        matches.setdefault(idx, (deal, method))
    matched_deals = {deal for deal, _ in matches.values()}
    unmatched_secops = [d for d in secops_deals if d not in matched_deals]

    fields = list(citi_rows[0].keys()) + ['SECOPS_DEAL', 'MATCH_METHOD']
    with open(out_path, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for idx, row in enumerate(citi_rows):
            deal, method = matches.get(idx, ('', 'no SecOps deal'))
            w.writerow({**row, 'SECOPS_DEAL': deal, 'MATCH_METHOD': method})
        for deal in unmatched_secops:
            w.writerow({'SECOPS_DEAL': deal, 'MATCH_METHOD': 'no Citi row'})

    print('Shelf -> issuer assignments (overlap, name score):')
    for shelf in sorted(secops_series_by_shelf):
        if shelf in shelf_issuer:
            _, issuer, overlap, ns = shelf_issuer[shelf]
            print(f'  {shelf:16} -> {issuer}  ({overlap}/{len(secops_series_by_shelf[shelf])}, {ns:.2f})')
        else:
            print(f'  {shelf:16} -> (none)')
    methods = defaultdict(int)
    for _, m in matches.values():
        methods[m] += 1
    print(f'\nCiti rows: {len(citi_rows)}, matched: {len(matches)} {dict(methods)}')
    print(f'SecOps deals: {len(secops_deals)}, unmatched: {len(unmatched_secops)}')
    print(f'Wrote {out_path}')


if __name__ == '__main__':
    main(*sys.argv[1:])
