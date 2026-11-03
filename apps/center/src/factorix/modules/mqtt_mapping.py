"""Validate the same MQTT source address before commissioning and binding."""

from typing import Any

from factorix.domain.jsonpath import MappingError, compile_path
from factorix.domain.mqtt_topics import filter_covers, valid_filter
from factorix.platform.errors import AppError


def validate_mqtt_address(config: dict[str, Any], address: Any, path: str) -> dict[str, Any]:
    def reject(field: str, code: str, message: str) -> None:
        raise AppError(422, 'MAPPING', message, field_errors=[{'path':f'{path}.{field}', 'code':code}])

    if not isinstance(address, dict):
        reject('topic', 'TOPIC_REQUIRED', 'Choose a source topic for this MQTT field.')
    assert isinstance(address, dict)
    result = dict(address)
    topic = result.get('topic')
    if not topic:
        configured = config.get('topics') or []
        if len(configured) == 1 and isinstance(configured[0], str) and not any(c in configured[0] for c in '+#'):
            topic = result['topic'] = configured[0]
        else:
            reject('topic', 'TOPIC_REQUIRED', 'Choose an explicit source topic for each field when the connection uses wildcards.')
    if not isinstance(topic, str) or not valid_filter(topic):
        reject('topic', 'TOPIC', 'The MQTT field topic filter is invalid.')
    if not any(filter_covers(allowed, topic) for allowed in config.get('topics') or []):
        reject('topic', 'TOPIC_SCOPE', 'The field topic must be within the connection topic filters.')
    expression = result.get('jsonpath')
    if not isinstance(expression, str) or not expression or len(expression.encode('utf-8')) > 2048:
        reject('jsonpath', 'JSONPATH', 'Enter a JSONPath for this MQTT field.')
    try:
        compile_path(expression)
    except MappingError:
        reject('jsonpath', 'JSONPATH', 'The JSONPath expression is invalid.')
    if 'qos' in result and (type(result['qos']) is not int or not 0 <= result['qos'] <= 2):
        reject('qos', 'QOS', 'MQTT QoS must be 0, 1 or 2.')
    if result.get('missing', 'OMIT') not in {'OMIT', 'BAD'}:
        reject('missing', 'MISSING_POLICY', 'Select OMIT or BAD for a missing field.')
    return result
