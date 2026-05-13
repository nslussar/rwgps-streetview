VERSION := $(shell git describe --tags --exact-match 2>/dev/null || echo "dev")
VERSION := $(VERSION:v%=%)

.PHONY: build clean release test

test:
	node --test test/*.test.js

build:
	@command -v jq >/dev/null || { echo "ERROR: jq is required for release build"; exit 1; }
	mkdir -p build/staging
	rm -rf build/staging
	mkdir -p build/staging
	cp -R background.js content lib popup icons build/staging/
	rm build/staging/lib/photospheres.js
	jq 'del(.content_scripts[0].js[] | select(. == "lib/photospheres.js")) | del(.web_accessible_resources[0].resources[] | select(. == "lib/photospheres.js"))' manifest.json > build/staging/manifest.json
	rm -f build/rwgps-streetview-$(VERSION).zip
	cd build/staging && zip -r ../rwgps-streetview-$(VERSION).zip .
	rm -rf build/staging
	@if unzip -l build/rwgps-streetview-$(VERSION).zip | grep -q photospheres; then \
		echo "ERROR: release zip contains photospheres file"; exit 1; fi
	@if unzip -p build/rwgps-streetview-$(VERSION).zip manifest.json | grep -q photospheres; then \
		echo "ERROR: release manifest references photospheres"; exit 1; fi
	@if unzip -p build/rwgps-streetview-$(VERSION).zip content/page-bridge.js | grep -Eq 'MapsJsInternalService|grpc-web-javascript|\$$rpc/'; then \
		echo "ERROR: release page-bridge.js contains SIS endpoint/transport surfaces"; exit 1; fi
	@echo "Created build/rwgps-streetview-$(VERSION).zip (release: SIS excluded)"

LAST_TAG := $(shell git tag --sort=-v:refname | head -1 | sed 's/^v//')
NEW_TAG := $(shell echo $(LAST_TAG) | awk -F. '{print $$1"."$$2"."$$3+1}')

release:
	git push origin main
	git tag v$(NEW_TAG)
	git push origin v$(NEW_TAG)
	@echo "Tagged and pushed v$(NEW_TAG) — GitHub Actions will create the release"

clean:
	rm -rf build
