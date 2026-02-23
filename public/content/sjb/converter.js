(function () {
  const { extractTitle, extractDegree, extractFieldOfStudy } = (window && window.sjbHelpers) || {};

  function transformSjbProfile(sjbProfile) {
    const contacts = [
      ...(sjbProfile.email ? [{ contact_type: "email", contact_value: sjbProfile.email }] : []),
      ...(sjbProfile.phone ? [{ contact_type: "phone", contact_value: sjbProfile.phone }] : []),
      ...(sjbProfile.phone ? [{ contact_type: "whatsapp", contact_value: sjbProfile.phone }] : []),
      ...(sjbProfile.linkedin_url
        ? [{ contact_type: "linkedin_url", contact_value: sjbProfile.linkedin_url }]
        : []),
      ...(sjbProfile.github ? [{ contact_type: "github", contact_value: sjbProfile.github }] : []),
    ];
    const addresses = sjbProfile.location
      ? [{ address_type: "current", street: "", city: sjbProfile.location, state: "", postal_code: "", country: "India" }]
      : [];
    const work_experiences = (sjbProfile.experiences || []).map((exp) => ({
      company_name: exp.company || "",
      company_description: "",
      company_website: "",
      industry: exp.industry || sjbProfile.industry || "",
      location: exp.location || "",
      job_title: exp.title || "",
      department: exp.department || "",
      start_date: exp.startDate || "",
      end_date: exp.endDate === "Present" ? null : exp.endDate || "",
      is_current: exp.endDate === "Present",
      work_summary: (exp.workSummary || "").trim(),
      work_experience_skills: Array.isArray(exp.workExperienceSkills) ? exp.workExperienceSkills : [],
    }));
    const educations = (sjbProfile.educations || []).map((edu) => {
      const start_date = edu.start_date || "";
      const completion_date = edu.completion_date || "";
      const degree = extractDegree(edu.course) || "";
      const specialization = extractFieldOfStudy(edu.course) || "";

      return {
        institution_name: edu.instituteName || "",
        degree: degree,
        field_of_study: "",
        specialization: specialization,
        start_date: start_date || null,
        completion_date: completion_date || null,
        grade: "",
        location: "",
        description: edu.course || "",
      };
    });
    const skills = (sjbProfile.skills || []).map((skill) => {
      if (typeof skill === "object" && skill !== null && "skill_name" in skill) {
        return {
          category: skill.category || "General",
          skill_name: skill.skill_name || "",
          proficiency: skill.proficiency || "",
          years_of_experience: skill.years_of_experience || "",
        };
      }
      return {
        category: "General",
        skill_name: skill || "",
        proficiency: "",
        years_of_experience: "",
      };
    });
    const projects = (sjbProfile.projects || []).map((proj) => ({
      title: proj.projectName || "",
      description: proj.description || "",
      role: "",
      client: "",
      start_date: null,
      end_date: null,
      technologies_used: proj.techStack ? [proj.techStack] : [],
      url: null,
    }));
    const certifications = (sjbProfile.licensesAndCertifications || []).map((cert) => {
      let issueDate = null;
      if (cert.year) {
        issueDate = `${cert.year}-01-01`;
      }
      return {
        name: cert.title || "",
        issuing_organization: "",
        issue_date: issueDate,
        expiry_date: null,
        credential_id: "",
        url: "",
      };
    });

    // Parse total experience from strings like "3 Yrs 5 Months"
    let totalExperienceYears = "";
    if (sjbProfile.totalExp) {
      const yearsMatch = sjbProfile.totalExp.match(/(\d+)\s*(?:Yrs?|Years?|Year)/i);
      const monthsMatch = sjbProfile.totalExp.match(/(\d+)\s*(?:Months?|Month|M)/i);
      const years = yearsMatch ? parseInt(yearsMatch[1], 10) || 0 : 0;
      const months = monthsMatch ? parseInt(monthsMatch[1], 10) || 0 : 0;
      if (years || months) {
        totalExperienceYears = `${years}y ${months}m`.trim();
      }
    }

    return {
      title: extractTitle(sjbProfile.name),
      full_name: sjbProfile.name || "",
      avatar: sjbProfile.profilePic || "",
      category: (sjbProfile.category || "").trim(),
      source: "SJ",
      headline: sjbProfile.currentlyWorkingAs || "",
      designation: (sjbProfile.designation || "").trim() || null,
      date_of_birth: sjbProfile.dob || "",
      place_of_birth: "",
      resume: sjbProfile.resume
        ? {
            candidate_id: "",
            resume_url: sjbProfile.resume || "",
            file_name:
              sjbProfile.resumeFileName ||
              `${(sjbProfile.name || "candidate").replace(/[^a-zA-Z0-9]/g, "_")}_resume.pdf`,
            downloaded_at: sjbProfile.resumeDownloadedAt || new Date().toISOString(),
          }
        : {},
      gender: (sjbProfile.gender || "").trim(),
      nationality: sjbProfile.nationality ? [sjbProfile.nationality] : [],
      religion: "",
      mother_tongue: "",
      marital_status: (sjbProfile.maritalStatus || "").trim(),
      notice_period: (sjbProfile.noticePeriod || "").trim(),
      modified_at: (sjbProfile.modifiedAt || "").trim(),
      last_active: (sjbProfile.lastActive || "").trim(),
      current_ctc: (sjbProfile.currentCtc || "").trim(),
      expected_ctc: (sjbProfile.expectedCtc || "").trim(),
      team_handled: (sjbProfile.teamHandled || "").trim() || null,
      desired_job_type: {
        job_type: (sjbProfile.jobType || "").trim(),
        employment_status: (sjbProfile.employmentStatus || "").trim(),
      },
      work_authority: Array.isArray(sjbProfile.workAuthority) ? sjbProfile.workAuthority : [],
      total_experience_years: totalExperienceYears,
      contacts,
      addresses,
      documents: [],
      professional_summary: {
        summary: sjbProfile.about || "",
        objective: null,
        relevant_experience_years: null,
        overseas_experience_years: null,
        expertise: null,
        key_achievements: null,
        industry_exposure: null,
        global_exposure: null,
        total_experience_years: totalExperienceYears || null,
        p_work_summary: null,
        industry: (sjbProfile.industry || "").trim() || null,
      },
      job_preference: {
        desired_job_type: (sjbProfile.jobType || "").trim() || null,
        preferred_locations: (() => {
          const prefLoc = sjbProfile.prefLocation;
          if (!prefLoc) return null;
          if (Array.isArray(prefLoc)) return prefLoc.length > 0 ? prefLoc : null;
          if (typeof prefLoc === "string" && prefLoc.trim()) {
            const locations = prefLoc
              .split(",")
              .map((loc) => loc.trim().replace(/\s+/g, " "))
              .filter((loc) => loc.length > 0);
            return locations.length > 0 ? locations : null;
          }
          return null;
        })(),
        willing_to_relocate: false,
        travel_willingness: null,
        notice_period: (sjbProfile.noticePeriod || "").trim() || null,
        reason_for_change: null,
        earliest_joining_date: null,
        functional_area: (() => {
          const fromMore = (sjbProfile.functionalArea || "").trim();
          const fromDesired = (sjbProfile.functionalAreaDesiredJob || "").trim();
          const combined = [fromMore, fromDesired].filter(Boolean).join(", ");
          return combined || null;
        })(),
        industry: (sjbProfile.industry || "").trim() || null,
        shift_type: (sjbProfile.shiftType || "").trim() || null,
        current_location: (sjbProfile.location || "").trim() || null,
      },
      job_board_unique_ids: {
        shine_id: sjbProfile.shineCandidateId || sjbProfile.sjbProfileUniqID || sjbProfile.shineProfileUniqID || "",
        naukri_id: "",
        linkedin_id: "",
      },
      work_experiences,
      educations,
      skills,
      languages: [],
      projects,
      certifications,
      trainings: [],
      achievements: [],
      publications: [],
      leadership_volunteering: [],
      affiliations: [],
      references: [],
    };
  }

  window.transformSjbProfile = transformSjbProfile;
})();

