from dataclasses import dataclass


@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    price_cents: int

    def __post_init__(self) -> None:
        if self.price_cents < 0:
            raise ValueError("price_cents must be non-negative")
