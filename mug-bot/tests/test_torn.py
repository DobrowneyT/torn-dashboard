from server import torn


def test_clothing_store_7star_plus():
    assert torn.is_clothing_store({"type_id": 5, "rating": 10}) is True
    assert torn.is_clothing_store({"type_id": 5, "rating": 7}) is True


def test_clothing_store_below_7star():
    assert torn.is_clothing_store({"type_id": 5, "rating": 6}) is False


def test_not_a_clothing_store_company():
    assert torn.is_clothing_store({"type_id": 1, "rating": 10}) is False


def test_missing_or_none():
    assert torn.is_clothing_store(None) is False
    assert torn.is_clothing_store({}) is False
