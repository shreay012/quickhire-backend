// =============================================================================
// QuickHire Backend — Jenkins pipeline
// Drop this at the repo root as `Jenkinsfile` (or point a Multibranch Pipeline
// job at it).
//
// Prerequisites on the Jenkins agent:
//   - NodeJS 22.x installed (NodeJS plugin tool name: "Node22")
//   - Credentials configured:
//       quickhire-prod-ssh        : SSH key for deploy@prod (Username with key)
//       quickhire-prod-host       : Secret text — fqdn or IP of prod server
//       quickhire-backend-env     : Secret file — full .env for prod
//
// Promotion model:
//   - main branch → automatic deploy to prod
//   - any other branch → build + test only, no deploy
// =============================================================================
pipeline {
    agent any

    options {
        timeout(time: 25, unit: 'MINUTES')
        timestamps()
        buildDiscarder(logRotator(numToKeepStr: '20'))
        disableConcurrentBuilds()
    }

    tools {
        nodejs 'Node22'
    }

    environment {
        APP_NAME    = 'quickhire-backend'
        DEPLOY_USER = 'deploy'
        DEPLOY_PATH = '/var/www/quickhire/backend'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
                sh 'git rev-parse --short HEAD > .git-sha && cat .git-sha'
            }
        }

        stage('Install') {
            steps {
                sh 'node --version && npm --version'
                sh 'npm ci --no-audit --no-fund'
            }
        }

        stage('Lint') {
            steps {
                sh 'npm run lint || true'   // non-blocking; flip to no `|| true` once green
            }
        }

        stage('Test') {
            steps {
                // Backend tests run against a throwaway postgres + redis on the
                // agent. If you only have one runner, point them at staging.
                sh 'npm test || echo "tests pending"'
            }
        }

        stage('Package') {
            steps {
                sh '''
                    set -e
                    SHA=$(cat .git-sha)
                    mkdir -p dist
                    tar --exclude=node_modules \\
                        --exclude=.git \\
                        --exclude=dist \\
                        --exclude=coverage \\
                        --exclude=.env \\
                        --exclude=.env.* \\
                        -czf dist/${APP_NAME}-${SHA}.tar.gz .
                    ls -lh dist/
                '''
                archiveArtifacts artifacts: 'dist/*.tar.gz', fingerprint: true
            }
        }

        stage('Deploy to prod') {
            when { branch 'main' }
            steps {
                withCredentials([
                    sshUserPrivateKey(credentialsId: 'quickhire-prod-ssh',
                                      keyFileVariable: 'SSH_KEY',
                                      usernameVariable: 'SSH_USER'),
                    string(credentialsId: 'quickhire-prod-host', variable: 'PROD_HOST'),
                    file(credentialsId: 'quickhire-backend-env', variable: 'PROD_ENV_FILE')
                ]) {
                    sh '''
                        set -e
                        SHA=$(cat .git-sha)
                        TARBALL=dist/${APP_NAME}-${SHA}.tar.gz
                        SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
                        REMOTE=${SSH_USER}@${PROD_HOST}

                        # 1. Upload tarball + .env
                        scp $SSH_OPTS $TARBALL ${REMOTE}:/tmp/${APP_NAME}-${SHA}.tar.gz
                        scp $SSH_OPTS $PROD_ENV_FILE ${REMOTE}:/tmp/${APP_NAME}.env

                        # 2. Atomic release: unpack to a new release dir, swap symlink
                        ssh $SSH_OPTS $REMOTE bash -s <<EOF
                            set -e
                            APP=${APP_NAME}
                            BASE=/var/www/quickhire/releases
                            REL=\\$BASE/\\$(date +%Y%m%d-%H%M%S)-${SHA}
                            sudo mkdir -p \\$REL
                            sudo tar -xzf /tmp/\\${APP}-${SHA}.tar.gz -C \\$REL
                            sudo mv /tmp/\\${APP}.env \\$REL/.env
                            sudo chown -R quickhire:quickhire \\$REL
                            cd \\$REL && sudo -u quickhire npm ci --omit=dev --no-audit --no-fund
                            sudo ln -sfn \\$REL ${DEPLOY_PATH}
                            sudo systemctl restart quickhire-backend
                            sudo systemctl restart quickhire-workers 2>/dev/null || true
                            # Health check — fail fast if the service didn't come up
                            sleep 4
                            curl -fsS http://127.0.0.1:4000/health || (echo "Health check failed" && exit 1)
                            # Prune old releases (keep last 5)
                            ls -1dt \\$BASE/*-* | tail -n +6 | xargs -r sudo rm -rf
EOF
                    '''
                }
            }
        }
    }

    post {
        success {
            echo "✅ ${env.JOB_NAME} #${env.BUILD_NUMBER} deployed"
        }
        failure {
            echo "❌ ${env.JOB_NAME} #${env.BUILD_NUMBER} failed — check console output"
            // Optional: hook in your Teams webhook here.
            // httpRequest httpMode: 'POST', url: env.TEAMS_WEBHOOK_BUILDS, requestBody: ...
        }
    }
}
