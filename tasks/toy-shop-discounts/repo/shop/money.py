"""Money helpers. All amounts in this package are integer cents."""


def parse_dollars(text: str) -> int:
    """Parse a dollar string such as "19.99" or "$5" into cents."""
    cleaned = text.strip().lstrip("$")
    if "." in cleaned:
        whole, frac = cleaned.split(".", 1)
        frac = (frac + "00")[:2]
    else:
        whole, frac = cleaned, "00"
    return int(whole or "0") * 100 + int(frac)


def format_cents(cents: int) -> str:
    """Format cents as a dollar string, e.g. 1999 -> "$19.99"."""
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}${cents // 100}.{cents % 100:02d}"
