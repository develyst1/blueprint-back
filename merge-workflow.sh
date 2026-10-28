#!/bin/bash
################################################################################
# Develyst Robot - Git Merge Workflow Script
################################################################################
# Description: Complete sync workflow - sync develop to your branch and vice versa
# Usage: 
#   ./merge-workflow.sh    # Run complete sync (one command does it all!)
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

# Get current branch name
get_current_branch() {
    git branch --show-current
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
            git stash push -m "Auto-stash by merge-workflow.sh at $(date)"
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

# Complete sync workflow
complete_sync() {
    print_header "🔄 Complete Sync Workflow"
    local current_branch=$(get_current_branch)
    
    # Validate branch
    if [ "$current_branch" == "develop" ]; then
        print_error "You are already on develop branch!"
        print_info "Switch to your feature branch first"
        exit 1
    fi
    
    if [ "$current_branch" == "main" ] || [ "$current_branch" == "master" ]; then
        print_error "Cannot sync main/master branch!"
        exit 1
    fi
    
    print_info "Current branch: $current_branch"
    check_uncommitted_changes
    
    echo ""
    print_info "📥 STEP 1: Syncing develop to $current_branch"
    echo "─────────────────────────────────────────────"
    
    # Fetch latest changes
    print_info "Fetching latest from origin..."
    git fetch origin
    
    # Update develop
    print_info "Updating develop branch..."
    git checkout develop
    git pull origin develop
    print_success "Develop updated"
    
    # Merge develop into current branch
    print_info "Switching to $current_branch..."
    git checkout "$current_branch"
    
    print_info "Merging develop into $current_branch..."
    if ! git merge develop --no-edit; then
        print_error "Merge conflict detected!"
        print_warning "Please resolve conflicts, then commit and run this script again"
        echo ""
        echo "Steps:"
        echo "  1. Fix conflicts in files"
        echo "  2. git add <files>"
        echo "  3. git commit"
        echo "  4. ./merge-workflow.sh"
        exit 1
    fi
    print_success "$current_branch synced with develop"
    
    echo ""
    print_info "📤 STEP 2: Syncing $current_branch to develop"
    echo "─────────────────────────────────────────────"
    
    # Push current branch
    print_info "Pushing $current_branch to origin..."
    git push origin "$current_branch"
    print_success "Branch pushed"
    
    # Merge to develop
    print_info "Switching to develop..."
    git checkout develop
    
    print_info "Merging $current_branch into develop..."
    if ! git merge "$current_branch" --no-edit; then
        print_error "Merge conflict detected!"
        print_warning "Resolve conflicts, commit, and push develop manually"
        exit 1
    fi
    print_success "$current_branch merged into develop"
    
    # Push develop
    print_info "Pushing develop to origin..."
    git push origin develop
    print_success "Develop pushed"
    
    # Switch back
    print_info "Switching back to $current_branch..."
    git checkout "$current_branch"
    
    # Summary
    echo ""
    print_header "✅ Sync Complete!"
    echo "✔️  develop → $current_branch (synced)"
    echo "✔️  $current_branch → develop (merged)"
    echo "✔️  All changes pushed to origin"
    echo ""
    print_success "You're all set! 🎉"
}

# Show help
show_help() {
    echo "Develyst Robot - Git Merge Workflow Script"
    echo ""
    echo "Usage:"
    echo "  ./merge-workflow.sh"
    echo ""
    echo "What it does:"
    echo "  1. Sync develop → your branch (get latest updates)"
    echo "  2. Sync your branch → develop (merge your changes)"
    echo "  3. Push everything to origin"
    echo ""
    echo "That's it! One command does it all. 🚀"
    echo ""
}

# ============================================================================
# Main Script
# ============================================================================

# Check if in git repo
check_git_repo

# Parse command (default to complete sync)
case "${1:-complete}" in
    complete|"")
        complete_sync
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