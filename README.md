# The Passport Page of a Country That Isn't There

make.fun entry for `the-passport-page-of-a-countr-2-20261121-0318`
($50 total, 1st $18), by @rappcuyy.

`main.py` (Python 3.13, standard library only) draws one invented passport
spread for the Republic of Kestrelia — a North Atlantic island republic,
capital Ternavik — and writes it to `/output/entry.png` (1024x720 PNG,
about 165 KB).

The spread:

- **Data page** — bearer Elena Maris Voss, born 12 MAR 1994 in Ternavik,
  passport KST 847 291, issued 14 JUN 2023, expiring 14 JUN 2033, with a
  drawn portrait, the arms of Kestrelia, a holder's signature, and a
  machine-readable zone with real ICAO 9303 check digits.
- **Visa page** — a Caldoria single-entry visa, arrival/departure stamps
  from Nordhavn, Caldoria and the Merrow Isles (every stamp falls after
  the issue date and before expiry, and the travel history runs forward
  in time), a harbour-duty fee stamp, and the endorsement that says what
  kind of place Kestrelia is: the bearer is a licensed lighthouse keeper
  of the Northern Reaches, fishing without levy in Kestrelia's waters.

Run it with no network:

```sh
python3 main.py            # writes /output/entry.png
OUTPUT_DIR=/tmp/out python3 main.py
```

It carries its own font atlas (DejaVu glyphs, packed as base64+zlib) and
its own PNG encoder, so nothing beyond the standard library is needed.
