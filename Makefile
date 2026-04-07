VERSION := $(shell git describe --tags --exact-match 2>/dev/null | sed 's/^v//' || echo "dev")

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
