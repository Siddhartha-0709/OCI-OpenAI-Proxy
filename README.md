# OCI OpenAI Proxy

A lightweight Node.js proxy that translates OpenAI‑compatible API calls (specifically the `/v1/chat/completions` endpoint used by n8n's OpenAI Chat Model node) into Oracle Cloud Infrastructure (OCI) Generative AI **Responses** API calls. This allows you to use OCI's generative AI models through any client that speaks the OpenAI chat completion protocol.

---

## Table of Contents
- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Environment Variables](#environment-variables)
- [Running Locally](#running-locally)
- [Docker Compose](#docker-compose)
- [Development](#development)
- [License](#license)

---

## Overview
The proxy sits between an OpenAI‑compatible client (e.g., n8n) and OCI's Generative AI service. It:

- Accepts OpenAI `POST /v1/chat/completions` requests.  
- Translates them into OCI's `/responses` API calls, handling schema sanitization and empty‑content guards.  
- Returns responses in the OpenAI chat completion format.

---

## Prerequisites
- **Node.js** (v14 or later) and **npm** if you want to run the service directly.  
- **Docker** (optional, for containerized execution).  
- An **OCI Generative AI** tenancy with a deployed model and the required service credentials.

---

## Environment Variables
Create a `.env` file in the project root with the following variables. You can also pass these values directly to the Docker container at runtime.

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Port on which the proxy will listen (default: `8080`). | No |
| `OCI_BASE_URL` | Base URL of your OCI Generative AI endpoint (e.g., `https://inference.generativeai.ap-hyderabad-1.oci.oraclecloud.com`). | **Yes** |
| `OCI_API_KEY` | API key (or `oci_api_key`/`oci Tenancy OCID`) if your setup uses a different auth method. | **Yes** |
| `OCI_PROJECT_ID` | OCI Generative AI **Project OCID** (e.g., `ocid1.generativeaiproject.oc1.ap-hyderabad-1.amaaaaaayzl4usya54fovosc.......`). | **Yes** |

> **Note:** The proxy uses `dotenv` to load these variables from a `.env` file. Do **not** commit this file to version control.

### Example `.env` file
```dotenv
# .env
PORT=8080
OCI_BASE_URL=https://inference.generativeai.ap-hyderabad-1.oci.oraclecloud.com/openai/v1
OCI_API_KEY=sk-your-oci-api-key
OCI_PROJECT_ID=ocid1.generativeaiproject.oc1.ap-hyderabad-1.amaaaaaayzl4usya54fovosc.......
```

Replace the placeholder values with your actual OCI credentials.

---

## Running Locally
1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Start the proxy**
   ```bash
   npm start
   ```
   The server will listen on the port defined in `PORT` (default `8080`). You can now point your OpenAI‑compatible client to `http://localhost:8080/v1`.

---

## Docker Compose
The project provides a ready‑made `docker-compose.yml` that pulls the pre‑built image, injects the required environment variables from a `.env` file, and starts the container.

### Prerequisite: .env file
Create a `.env` file in the project root containing the required variables (see the **Environment Variables** section above). Example:

```dotenv
PORT=8080
OCI_BASE_URL=https://inference.generativeai.ap-hyderabad-1.oci.oraclecloud.com/openai/v1
OCI_API_KEY=sk-your-oci-api-key
OCI_PROJECT_ID=ocid1.generativeaiproject.oc1.ap-hyderabad-1.amaaaaaayzl4usya54fovosc.......
```

### Using Docker Compose
```bash
# Start the service in detached mode
docker compose up -d

# (or, with the legacy CLI)
docker-compose up -d

# Stop and remove the containers
docker compose down
```

The compose file maps port `8080` on the host to the container's port `8080`. Once started, the proxy will be accessible at `http://localhost:8080/v1`.

<!-- Duplicate Docker Compose instructions removed -->

---

## Development
- **Make changes** to `server.js` or other source files.  
- **Hot‑reload** (optional) by using `nodemon`:  
  ```bash
  npm install -g nodemon
  nodemon server.js
  ```
- **Run tests** (if you add any) using your preferred test framework.

---

## License
MIT © 2025 Siddhartha Mukherjee