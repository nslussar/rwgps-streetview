VERSION := $(shell git describe --tags --exact-match 2>/dev/null || echo "dev")
VERSION := $(VERSION:v%=%)

.PHONY: build clean release test

test:
	node --test test/*.test.js

build:
	mkdir -p build
	rm -f build/rwgps-streetview-$(VERSION).zip
	zip -r build/rwgps-streetview-$(VERSION).zip \
		manifest.json \
		background.js \
		content/ \
		lib/ \
		popup/ \
		icons/
	@echo "Created build/rwgps-streetview-$(VERSION).zip"

LAST_TAG := $(shell git tag --sort=-v:refname | head -1 | sed 's/^v//')
NEW_TAG := $(shell echo $(LAST_TAG) | awk -F. '{print $$1"."$$2"."$$3+1}')

release:
	git push origin main
	git tag v$(NEW_TAG)
	git push origin v$(NEW_TAG)
	@echo "Tagged and pushed v$(NEW_TAG) — GitHub Actions will create the release"

clean:
	rm -rf build
