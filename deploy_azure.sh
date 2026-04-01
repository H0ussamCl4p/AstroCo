#!/bin/bash
# Exit on error
set -e

echo "=== Deploying AstroCo to Azure ==="

# 1. Update system and install dependencies
sudo apt-get update
sudo apt-get install -y python3.10 python3.10-venv python3-pip nginx certbot python3-certbot-nginx zip unzip curl git

# 2. Install Node.js
if ! command -v node &> /dev/null
then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# 3. Install Ollama if not present
if ! command -v ollama &> /dev/null
then
    echo "Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
fi

# Start Ollama service automatically
sudo systemctl enable --now ollama

# Pull models with Ollama
echo "Pulling models..."
ollama pull gemma3:1b
ollama pull nomic-embed-text

# 4. Set up the project directory
APP_DIR="/opt/astroco"
if [ ! -d "$APP_DIR" ]; then
    echo "Creating directory $APP_DIR and copying current files..."
    sudo mkdir -p $APP_DIR
    sudo cp -r . $APP_DIR
    sudo chown -R $USER:$USER $APP_DIR
else
    echo "Directory $APP_DIR already exists, updating files..."
    sudo cp -r . $APP_DIR
    sudo chown -R $USER:$USER $APP_DIR
fi

cd $APP_DIR

# 5. Build Frontend
echo "Building frontend..."
cd frontend
npm install
npm run build
cd ..

# 6. Set up Python backend
echo "Setting up Python backend..."
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python backend/build_rag_index.py || echo "RAG index build warning, continuing..."

# 7. Setup Systemd Service for Backend
echo "Configuring Systemd for Python backend..."
cat <<EOF | sudo tee /etc/systemd/system/astroco-backend.service
[Unit]
Description=AstroCo Backend
After=network.target ollama.service

[Service]
User=$USER
WorkingDirectory=$APP_DIR
Environment="PATH=$APP_DIR/.venv/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=$APP_DIR/.venv/bin/python backend/vr_backend.py
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now astroco-backend.service

# 8. Setup Nginx
echo "Configuring Nginx..."
sudo cp nginx.conf /etc/nginx/sites-available/astroco
sudo ln -sf /etc/nginx/sites-available/astroco /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo systemctl restart nginx

echo "=== Deployment Finished ==="
echo "If you have an Azure DNS name configured (e.g. astroco.eastus.cloudapp.azure.com),"
echo "Run Let's Encrypt to secure the site with HTTPS:"
echo "sudo certbot --nginx -d YOUR_AZURE_DNS_NAME"
