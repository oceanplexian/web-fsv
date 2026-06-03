.PHONY: install dev files gen-demo verify image ecr push provision url-permissions \
        deploy redeploy url logs tf-init tf-apply tf-destroy clean

# ── Config ───────────────────────────────────────────────────
PORT        ?= 8765
LAMBDA_NAME ?= web-fsv-demo
AWS_REGION  ?= us-east-1
TF_DIR      := tf
LAMBDA_IMAGE := web-fsv-lambda:latest
PLATFORM    := linux/arm64

# ── Local development ────────────────────────────────────────
install:
	npm ci

# Run the hosted-style demo locally (bundled Isla Nublar tree).
dev: install
	FSV_SOURCE=demo PORT=$(PORT) node server.js

# Fly through a REAL directory on this machine: `make files DIR=~/projects`
files: install
	FSV_SOURCE=files PORT=$(PORT) node server.js
	@echo "open http://localhost:$(PORT)/?path=$(DIR)"

# Regenerate data/demo-tree.json from the generator.
gen-demo:
	node scripts/gen-demo-tree.mjs

# ── Lambda image ─────────────────────────────────────────────
image:
	docker build -f Dockerfile.lambda --platform $(PLATFORM) -t $(LAMBDA_IMAGE) .

# Create just the ECR repo (first), so the image has somewhere to go before the
# Lambda function — which references the image — is created.
ecr: tf-init
	terraform -chdir=$(TF_DIR) apply -auto-approve -target=aws_ecr_repository.this

push: image
	@set -e; \
	ECR_REPO="$$(terraform -chdir=$(TF_DIR) output -raw ecr_repo)"; \
	aws ecr get-login-password --region $(AWS_REGION) | docker login --username AWS --password-stdin "$$ECR_REPO"; \
	docker tag $(LAMBDA_IMAGE) "$$ECR_REPO:latest"; \
	docker push "$$ECR_REPO:latest"

provision: tf-init
	terraform -chdir=$(TF_DIR) apply -auto-approve
	@$(MAKE) url-permissions

# A public Function URL in this account needs BOTH lambda:InvokeFunctionUrl
# (created by Terraform) and lambda:InvokeFunction scoped to URL invokes.
# Terraform can't express the InvokedViaFunctionUrl condition, so grant it here.
url-permissions:
	-@aws lambda add-permission --function-name $(LAMBDA_NAME) --region $(AWS_REGION) \
		--statement-id FunctionURLAllowInvokeFunction --action lambda:InvokeFunction \
		--principal "*" --invoked-via-function-url >/dev/null 2>&1 || true
	@echo "url permissions ensured"

# First-time deploy: ECR -> build+push -> create Lambda + URL.
deploy: ecr push provision url

# Ship new code to an existing function.
redeploy: push
	@set -e; \
	aws lambda update-function-code --function-name $(LAMBDA_NAME) --region $(AWS_REGION) \
		--image-uri "$$(terraform -chdir=$(TF_DIR) output -raw ecr_repo):latest" >/dev/null; \
	aws lambda wait function-updated --function-name $(LAMBDA_NAME) --region $(AWS_REGION); \
	echo "redeployed $(LAMBDA_NAME)"

url:
	@terraform -chdir=$(TF_DIR) output -raw function_url

logs:
	aws logs tail /aws/lambda/$(LAMBDA_NAME) --region $(AWS_REGION) --follow

# ── Terraform ────────────────────────────────────────────────
tf-init:
	terraform -chdir=$(TF_DIR) init -input=false

tf-apply: tf-init
	terraform -chdir=$(TF_DIR) apply -auto-approve

tf-destroy: tf-init
	terraform -chdir=$(TF_DIR) destroy -auto-approve

clean:
	rm -rf node_modules
