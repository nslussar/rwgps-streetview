VERSION := $(shell git describe --tags --exact-match 2>/dev/null || echo "dev")
VERSION := $(VERSION:v%=%)

.PHONY: build clean

build:
	mkdir -p build
	rm -f build/rwgps-streetview-$(VERSION).zip
	zip -r build/rwgps-streetview-$(VERSION).zip \
		manifest.json \
		content/ \
		lib/ \
		popup/ \
		icons/
	@echo "Created build/rwgps-streetview-$(VERSION).zip"

clean:
	rm -rf build
