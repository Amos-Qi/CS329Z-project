import pytest

from shop import Cart, Product
from shop.money import format_cents, parse_dollars

APPLE = Product("apl", "Apple", 120)
BREAD = Product("brd", "Bread", 349)


def test_subtotal_and_total():
    cart = Cart()
    cart.add(APPLE, 3)
    cart.add(BREAD)
    assert cart.subtotal_cents() == 709
    assert cart.total_cents() == 709


def test_add_merges_lines():
    cart = Cart()
    cart.add(APPLE)
    cart.add(APPLE, 2)
    assert cart.items["apl"].quantity == 3


def test_remove_partial_and_full():
    cart = Cart()
    cart.add(APPLE, 3)
    cart.remove("apl", 1)
    assert cart.items["apl"].quantity == 2
    cart.remove("apl")
    assert cart.subtotal_cents() == 0
    with pytest.raises(KeyError):
        cart.remove("apl")


def test_money_helpers():
    assert parse_dollars("$19.99") == 1999
    assert parse_dollars("5") == 500
    assert format_cents(1999) == "$19.99"
    assert format_cents(-5) == "-$0.05"
