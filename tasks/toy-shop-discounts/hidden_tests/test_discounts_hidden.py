"""Hidden behavioral tests for toy-shop-discounts. Never copied into the agent's workspace."""

import pytest

from shop import Cart, Product
from shop.discounts import DISCOUNT_CODES, Discount

ITEM = Product("x", "Thing", 1999)
BIG = Product("b", "Big thing", 2500)


def cart_with(*products):
    cart = Cart()
    for p in products:
        cart.add(p)
    return cart


def test_registry_contains_required_codes():
    assert DISCOUNT_CODES["SAVE10"] == Discount("percent", 10)
    assert DISCOUNT_CODES["FIVEOFF"] == Discount("fixed", 500)
    assert DISCOUNT_CODES["BIG20"] == Discount("percent", 20, min_subtotal_cents=5000)


def test_percent_rounds_half_up():
    cart = cart_with(ITEM)  # 1999 * 10% = 199.9 -> 200
    cart.apply_code("SAVE10")
    assert cart.discount_cents() == 200
    assert cart.total_cents() == 1799


def test_percent_half_cent_rounds_up():
    cart = cart_with(Product("h", "Half", 1005))  # 10% = 100.5 -> 101
    cart.apply_code("SAVE10")
    assert cart.discount_cents() == 101


def test_fixed_never_below_zero():
    cart = cart_with(Product("c", "Cheap", 300))
    cart.apply_code("FIVEOFF")
    assert cart.discount_cents() == 300
    assert cart.total_cents() == 0


def test_unknown_code_raises():
    cart = cart_with(ITEM)
    with pytest.raises(ValueError):
        cart.apply_code("NOPE")


def test_codes_are_case_insensitive():
    cart = cart_with(ITEM)
    cart.apply_code("save10")
    assert cart.discount_cents() == 200


def test_new_code_replaces_old():
    cart = cart_with(ITEM)
    cart.apply_code("SAVE10")
    cart.apply_code("FIVEOFF")
    assert cart.discount_cents() == 500


def test_min_subtotal_enforced_at_apply():
    cart = cart_with(BIG)
    with pytest.raises(ValueError):
        cart.apply_code("BIG20")


def test_min_subtotal_rechecked_after_removal():
    cart = cart_with(BIG, BIG)
    cart.apply_code("BIG20")
    assert cart.discount_cents() == 1000
    cart.remove("b", 1)
    assert cart.discount_cents() == 0
    assert cart.total_cents() == 2500


def test_no_code_no_discount():
    cart = cart_with(ITEM)
    assert cart.discount_cents() == 0
    assert cart.total_cents() == 1999
