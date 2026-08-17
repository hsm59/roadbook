IMAGE ?= roadbook-pwa
TAG   ?= latest
PORT  ?= 8080

.PHONY: build run stop shell push multiarch clean size help

help:
	@echo "make build      - build the image"
	@echo "make run        - run on http://localhost:$(PORT)"
	@echo "make size       - show image size"
	@echo "make multiarch  - build amd64+arm64 and push (set REGISTRY)"
	@echo "make push       - tag and push to \$$REGISTRY"

build:
	docker build -t $(IMAGE):$(TAG) .

run: build
	docker run --rm -p $(PORT):8080 -e PORT=8080 --name roadbook $(IMAGE):$(TAG)

stop:
	-docker stop roadbook

shell:
	docker run --rm -it --entrypoint sh $(IMAGE):$(TAG)

size:
	docker images $(IMAGE):$(TAG) --format "{{.Repository}}:{{.Tag}}  {{.Size}}"

# Fly and Apple Silicon want arm64; most PaaS want amd64. Build both.
multiarch:
	@test -n "$(REGISTRY)" || (echo "set REGISTRY=ghcr.io/<user>"; exit 1)
	docker buildx build --platform linux/amd64,linux/arm64 \
		-t $(REGISTRY)/$(IMAGE):$(TAG) --push .

push:
	@test -n "$(REGISTRY)" || (echo "set REGISTRY=ghcr.io/<user>"; exit 1)
	docker tag $(IMAGE):$(TAG) $(REGISTRY)/$(IMAGE):$(TAG)
	docker push $(REGISTRY)/$(IMAGE):$(TAG)

clean:
	-docker rmi $(IMAGE):$(TAG)
