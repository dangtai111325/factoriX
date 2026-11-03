"""HTTP settings are explicit; credentials belong in encrypted secret storage."""

import pytest

from factorix.modules.protocols import parse_config
from factorix.platform.errors import AppError


@pytest.mark.parametrize("headers", [{"Authorization": "test-token"}, {"cookie": "test-cookie"}, {"X-API-Key": "test-key"}])
def test_sensitive_http_headers_require_the_authentication_fields(headers):
    with pytest.raises(AppError) as error:
        parse_config("http", {"base_url": "https://example.com", "headers": headers})
    assert error.value.code == "SECRET"


@pytest.mark.parametrize("url", ["https://reader:password@example.com", "https://reader@example.com"])
def test_http_credentials_are_not_stored_inside_the_url(url):
    with pytest.raises(AppError) as error:
        parse_config("http", {"base_url": url})
    assert error.value.code == "SECRET"
