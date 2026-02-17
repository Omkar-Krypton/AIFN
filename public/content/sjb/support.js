(function () {
  function extractTitle(name) {
    if (!name) return "";
    const titles = ["Mr.", "Mrs.", "Ms.", "Dr.", "Prof."];
    for (const title of titles) {
      if (name.startsWith(title)) return title;
    }
    return "";
  }

  function extractStartDate(duration) {
    if (!duration) return "";
    const parts = duration.split("-");
    return parts[0]?.trim() || "";
  }

  function extractEndDate(duration) {
    if (!duration) return "";
    const parts = duration.split("-");
    return parts[1]?.trim() || "";
  }

  function extractDegree(course) {
    if (!course) return "";
    const m = course.match(/^([^,-]+)/);
    return m ? m[1].trim() : course;
  }

  function extractFieldOfStudy(course) {
    if (!course) return "";
    return course.split("|").pop().trim();
  }

  window.sjbHelpers = {
    extractTitle,
    extractStartDate,
    extractEndDate,
    extractDegree,
    extractFieldOfStudy,
  };
})();

