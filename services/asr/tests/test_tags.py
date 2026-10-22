from asr_service.tags import EMOTIONS, EVENTS, parse_sensevoice


def test_typical_chinese_output():
    r = parse_sensevoice("<|zh|><|NEUTRAL|><|Speech|><|withitn|>今天天气怎么样？")
    assert r.text == "今天天气怎么样？"
    assert r.emotion == "neutral"
    assert r.events == ["speech"]


def test_woitn_and_other_emotion_event():
    r = parse_sensevoice("<|zh|><|HAPPY|><|Laughter|><|woitn|>哈哈太好了")
    assert r.text == "哈哈太好了"
    assert r.emotion == "happy"
    assert r.events == ["laughter"]


def test_every_emotion_tag_maps_into_documented_set():
    for tag, expected in [
        ("NEUTRAL", "neutral"), ("HAPPY", "happy"), ("SAD", "sad"), ("ANGRY", "angry"),
        ("FEARFUL", "fearful"), ("DISGUSTED", "disgusted"), ("SURPRISED", "surprised"),
        ("EMO_UNKNOWN", "unknown"),
    ]:
        r = parse_sensevoice(f"<|zh|><|{tag}|><|Speech|><|withitn|>好")
        assert r.emotion == expected
        assert r.emotion in EMOTIONS


def test_every_event_tag_maps_into_documented_set():
    for tag in ["Speech", "BGM", "Applause", "Laughter", "Cry", "Sneeze", "Breath", "Cough"]:
        r = parse_sensevoice(f"<|zh|><|NEUTRAL|><|{tag}|><|withitn|>好")
        assert r.events == [tag.lower()]
        assert set(r.events) <= set(EVENTS)


def test_no_tags_left_and_unknown_tags_dropped():
    r = parse_sensevoice("<|nospeech|><|EMO_UNKNOWN|><|Event_UNK|><|SPECIAL_TOKEN_5|>")
    assert r.text == ""
    assert r.emotion == "unknown"
    assert r.events == []


def test_missing_emotion_is_unknown():
    r = parse_sensevoice("你好")
    assert (r.text, r.emotion, r.events) == ("你好", "unknown", [])


def test_multiple_segments_concatenate_and_first_known_emotion_wins():
    raw = (
        "<|zh|><|EMO_UNKNOWN|><|Speech|><|withitn|>第一句。"
        "<|zh|><|SAD|><|Cough|><|withitn|>第二句。"
        "<|zh|><|ANGRY|><|Speech|><|withitn|>第三句。"
    )
    r = parse_sensevoice(raw)
    assert r.text == "第一句。 第二句。 第三句。"
    assert r.emotion == "sad"
    assert r.events == ["speech", "cough"]


def test_english_spacing_is_normalized():
    r = parse_sensevoice("<|en|><|NEUTRAL|><|Speech|><|withitn|> Hello  world. ")
    assert r.text == "Hello world."
