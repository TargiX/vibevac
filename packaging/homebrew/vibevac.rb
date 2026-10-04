cask "vibevac" do
  version "0.1.0"
  sha256 "dc97e6cbf9c31e828f0f68d3b593f3c03235706098b4ab677df179dec2099e09"

  url "https://github.com/TargiX/vibevac/releases/download/v#{version}/VibeVac_#{version}_universal.dmg"
  name "VibeVac"
  desc "Reclaim rebuildable storage from AI coding workspaces and Git worktrees"
  homepage "https://github.com/TargiX/vibevac"

  livecheck do
    url :url
    strategy :github_releases
  end

  depends_on macos: ">= :monterey"

  app "VibeVac.app"

  zap trash: [
    "~/.vibevac",
    "~/Library/Application Support/com.ilyamoskovkin.vibevac",
    "~/Library/Caches/com.ilyamoskovkin.vibevac",
    "~/Library/Saved Application State/com.ilyamoskovkin.vibevac.savedState",
    "~/Library/WebKit/com.ilyamoskovkin.vibevac",
  ]
end
