from dataclasses import dataclass, field

from shop.catalog import Product
from shop.money import format_cents


@dataclass
class LineItem:
    product: Product
    quantity: int

    @property
    def total_cents(self) -> int:
        return self.product.price_cents * self.quantity


@dataclass
class Cart:
    items: dict[str, LineItem] = field(default_factory=dict)

    def add(self, product: Product, quantity: int = 1) -> None:
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        if product.sku in self.items:
            self.items[product.sku].quantity += quantity
        else:
            self.items[product.sku] = LineItem(product, quantity)

    def remove(self, sku: str, quantity: int | None = None) -> None:
        """Remove `quantity` units of `sku`, or the whole line when quantity is None."""
        item = self.items.get(sku)
        if item is None:
            raise KeyError(sku)
        if quantity is None or quantity >= item.quantity:
            del self.items[sku]
        else:
            item.quantity -= quantity

    def subtotal_cents(self) -> int:
        return sum(item.total_cents for item in self.items.values())

    def total_cents(self) -> int:
        return self.subtotal_cents()

    def summary(self) -> str:
        lines = [f"{i.quantity} x {i.product.name}: {format_cents(i.total_cents)}" for i in self.items.values()]
        lines.append(f"Total: {format_cents(self.total_cents())}")
        return "\n".join(lines)
