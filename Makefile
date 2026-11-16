VERSION ?= $(shell node -p "require('./package.json').version")
IMAGE ?= registry.pying.ca/libretv:$(VERSION)
PLATFORMS ?= linux/amd64,linux/arm64
BUILDER ?= mubuildx

.PHONY: build push

# Build and load the current machine's platform into local Docker.
build:
	docker buildx build --builder "$(BUILDER)" --load --tag "$(IMAGE)" .

# Build and publish both NAS/server architectures.
push:
	docker buildx build --builder "$(BUILDER)" --platform "$(PLATFORMS)" --push --tag "$(IMAGE)" .
