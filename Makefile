.PHONY: env certs build up down reset logs ps kafka-ui demo clean

VENV := .venv

env:
	@test -f .env || (cp .env.example .env && echo "Created .env from .env.example")

certs: env
	@./tools/scripts/gen-certs.sh

build: certs
	docker compose build

up: build
	docker compose up -d
	@echo ""
	@echo "Waiting for services to become healthy: make ps"
	@echo "Keycloak admin console: https://auth.localhost/admin (admin / KEYCLOAK_ADMIN_PASSWORD)"
	@echo "Grafana (traces, logs): http://127.0.0.1:3000"

# --profile tools: also stop opt-in tools (kafka-ui); `down` ignores inactive profiles.
down:
	docker compose --profile tools down

reset:
	docker compose --profile tools down -v
	@echo "Volumes wiped. TLS certs kept (make certs to regenerate)."

logs:
	docker compose logs -f --tail=50

ps:
	docker compose ps

kafka-ui:
	docker compose --profile tools up -d --wait kafka-ui
	@echo "Kafka UI (read-only): http://127.0.0.1:8080"

demo: $(VENV)/.stamp
	$(VENV)/bin/python tools/demo/client.py

$(VENV)/.stamp: tools/demo/requirements.txt
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -q -r tools/demo/requirements.txt
	@touch $(VENV)/.stamp
	@echo "Demo virtualenv ready: $(VENV)"

clean:
	rm -rf $(VENV) tools/demo/out
