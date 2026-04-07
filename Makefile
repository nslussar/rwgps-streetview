VERSION := $(shell python3 -c "import json; print(json.load(open('manifest.json'))['version'])")

.PHONY: build clean

build:
	mkdir -p build
	rm -f build/ridewithgps-streetview-$(VERSION).zip
	zip -r build/ridewithgps-streetview-$(VERSION).zip \
		manifest.json \
		content/ \
		lib/ \
		popup/ \
		icons/
	@echo "Created build/ridewithgps-streetview-$(VERSION).zip"

clean:
	rm -rf build
