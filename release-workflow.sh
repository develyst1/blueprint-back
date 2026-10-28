#!/bin/bash
################################################################################
# Develyst Robot - Git Release Workflow Script
################################################################################
# Description: Release workflow - merge develop into production
# Usage: 
#   ./release-workflow.sh    # Run complete release (one command does it all!)
################################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================================
# Helper Functions
# ============================================================================

print_header() {
    echo -e "\n${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}\n"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

# Check if we're in a git repository
check_git_repo() {
    if ! git rev-parse --git-dir > /dev/null 2>&1; then
        print_error "Not a git repository!"
        exit 1
    fi
}

# Check for uncommitted changes
check_uncommitted_changes() {
    if ! git diff-index --quiet HEAD --; then
        print_warning "You have uncommitted changes!"
        echo -e "Please commit or stash your changes before continuing.\n"
        git status --short
        echo ""
        read -p "Do you want to stash changes and continue? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            git stash push -m "Auto-stash by release-workflow.sh at $(date)"
            print_success "Changes stashed"
            return 0
        else
            print_error "Operation cancelled"
            exit 1
        fi
    fi
}

# ============================================================================
# Main Functions
# ============================================================================

# Complete release workflow: develop → production
complete_release() {
    print_header "🚀 Release Workflow: develop → production"

    local original_branch=$(git branch --show-current)
    print_info "Original branch: $original_branch"

    check_uncommitted_changes

    echo ""
    print_info "📥 STEP 1: Update develop from origin"
    echo "─────────────────────────────────────────────"

    # Fetch latest changes
    print_info "Fetching latest from origin..."
    git fetch origin

    # Update develop
    print_info "Updating develop branch..."
    git checkout develop
    git pull origin develop
    print_success "Develop updated"

    echo ""
    print_info "📤 STEP 2: Merge develop into production"
    echo "─────────────────────────────────────────────"

    # Switch to production
    print_info "Switching to production..."
    git checkout production
    git pull origin production
    print_success "Production updated"

    # Merge develop into production
    print_info "Merging develop into production..."
    if ! git merge develop --no-edit; then
        print_error "Merge conflict detected!"
        print_warning "Please resolve conflicts, then commit and run this script again"
        echo ""
        echo "Steps:"
        echo "  1. Fix conflicts in files"
        echo "  2. git add <files>"
        echo "  3. git commit"
        echo "  4. ./release-workflow.sh"
        exit 1
    fi
    print_success "develop merged into production"

    # Push production
    print_info "Pushing production to origin..."
    git push origin production
    print_success "Production pushed"

    # Switch back to original branch
    print_info "Switching back to $original_branch..."
    git checkout "$original_branch"

    # Summary
    echo ""
    print_header "✅ Release Complete!"
    echo "✔️  develop → production (merged)"
    echo "✔️  production pushed to origin"
    echo "✔️  Back on $original_branch"
    echo ""
    print_success "Release is live! 🎉"
}

# Show help
show_help() {
    echo "Develyst Robot - Git Release Workflow Script"
    echo ""
    echo "Usage:"
    echo "  ./release-workflow.sh"
    echo ""
    echo "What it does:"
    echo "  1. Pull latest develop from origin"
    echo "  2. Merge develop → production"
    echo "  3. Push production to origin"
    echo ""
    echo "That's it! One command does it all. 🚀"
    echo ""
}

# ============================================================================
# Main Script
# ============================================================================

# Check if in git repo
check_git_repo

# Parse command (default to complete release)
case "${1:-complete}" in
    complete|"")
        complete_release
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        print_error "Unknown command: ${1}"
        echo ""
        show_help
        exit 1
        ;;
esac
